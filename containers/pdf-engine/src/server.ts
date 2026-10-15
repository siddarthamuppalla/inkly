// pdf-engine: compresses PDFs with Ghostscript and checks the result with qpdf.
// The HTTP contract is in ../README.md.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BYTES = Number(process.env.PDF_ENGINE_MAX_BYTES ?? 200 * 1024 * 1024);
const TIMEOUT_MS = Number(process.env.PDF_ENGINE_TIMEOUT_MS ?? 120_000);
const LEVELS = new Set(["screen", "ebook", "printer"]);

/** An expected failure, answered as `status` with `{ error: code }`. */
class Refusal extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
}

function run(cmd: string, args: readonly string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout });
    });
  });
}

function limit(max: number) {
  return async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    let total = 0;
    for await (const chunk of source) {
      total += chunk.length;
      if (total > max) throw new Refusal(413, "payload_too_large");
      yield chunk;
    }
  };
}

async function pageCount(file: string, signal: AbortSignal): Promise<number> {
  return Number((await run("qpdf", ["--show-npages", file], signal)).stdout.trim());
}

async function compress(
  req: IncomingMessage,
  level: string,
  signal: AbortSignal,
): Promise<{ body: Buffer; compressed: boolean }> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BYTES) {
    throw new Refusal(413, "payload_too_large");
  }
  const dir = await mkdtemp(join(tmpdir(), "pdf-engine-"));
  try {
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.pdf");
    await pipeline(req, limit(MAX_BYTES), createWriteStream(input), { signal });
    if ((await run("qpdf", ["--is-encrypted", input], signal)).code === 0) {
      throw new Refusal(422, "pdf_encrypted");
    }
    if ((await run("qpdf", ["--check", input], signal)).code !== 0) {
      throw new Refusal(422, "pdf_malformed");
    }
    const gs = await run(
      "gs",
      [
        "-q",
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=pdfwrite",
        `-dPDFSETTINGS=/${level}`,
        `-sOutputFile=${output}`,
        input,
      ],
      signal,
    );
    const valid =
      gs.code === 0 &&
      (await run("qpdf", ["--check", output], signal)).code === 0 &&
      (await pageCount(output, signal)) === (await pageCount(input, signal));
    if (!valid) throw new Error(`Ghostscript produced no valid output (exit ${String(gs.code)})`);
    if ((await stat(output)).size < (await stat(input)).size) {
      return { body: await readFile(output), compressed: true };
    }
    return { body: await readFile(input), compressed: false };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sendError(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
  req.resume();
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error }));
}

async function handleCompress(req: IncomingMessage, res: ServerResponse, url: URL) {
  const level = url.searchParams.get("level") ?? "";
  if (!LEVELS.has(level)) {
    sendError(req, res, 422, "invalid_level");
    return;
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const { body, compressed } = await compress(req, level, signal);
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": body.length,
      "x-inkly-compressed": String(compressed),
    });
    res.end(body);
  } catch (e) {
    if (e instanceof Refusal) {
      sendError(req, res, e.status, e.code);
    } else if (signal.aborted) {
      sendError(req, res, 504, "timeout");
    } else {
      console.error(e);
      sendError(req, res, 500, "internal");
    }
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://pdf-engine");
  const routes: Record<string, { method: string; run: () => Promise<void> | void }> = {
    "/health": {
      method: "GET",
      run: () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      },
    },
    "/compress": { method: "POST", run: () => handleCompress(req, res, url) },
  };
  const route = routes[url.pathname];
  if (route === undefined) {
    sendError(req, res, 404, "not_found");
  } else if (req.method !== route.method) {
    sendError(req, res, 405, "method_not_allowed");
  } else {
    await route.run();
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});
server.listen(PORT, () => {
  console.log(`pdf-engine listening on ${String((server.address() as AddressInfo).port)}`);
});
process.on("SIGTERM", () => server.close());
