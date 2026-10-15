import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFile } from "@inkly/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const server = join(import.meta.dirname, "../src/server.ts");
const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Buffer => readFileSync(join(corpus, name));
const out = mkdtempSync(join(tmpdir(), "pdf-engine-test-"));

interface Engine {
  readonly url: string;
  readonly process: ChildProcess;
}

/** Starts the real entrypoint on a free port and waits for its listening line. */
function start(env: Record<string, string> = {}): Promise<Engine> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", server], {
    env: { ...process.env, PORT: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const port = /listening on (\d+)/.exec(seen)?.[1];
      if (port !== undefined) resolve({ url: `http://127.0.0.1:${port}`, process: child });
    });
    child.on("exit", (code) => {
      reject(new Error(`pdf-engine exited with ${String(code)}`));
    });
  });
}

function compress(engine: Engine, body: Uint8Array, level = "ebook"): Promise<Response> {
  return fetch(`${engine.url}/compress?level=${level}`, { method: "POST", body });
}

let engine: Engine;
const extra: Engine[] = [];
beforeAll(async () => {
  engine = await start();
});
afterAll(() => {
  for (const e of [engine, ...extra]) e.process.kill();
  rmSync(out, { recursive: true, force: true });
});

describe("GET /health", () => {
  it("answers ok", async () => {
    const res = await fetch(`${engine.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("POST /compress", () => {
  it("returns smaller bytes for huge-image.pdf that pass verify-pdf with the same page count", async () => {
    const input = fixture("huge-image.pdf");
    const res = await compress(engine, input, "screen");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-inkly-compressed")).toBe("true");
    const output = new Uint8Array(await res.arrayBuffer());
    expect(output.length).toBeLessThan(input.length);
    const file = join(out, "huge-image.compressed.pdf");
    writeFileSync(file, output);
    const verdict = verifyFile(file, { expectPages: 1 });
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("keeps every page of a multi-page document at each level", async () => {
    for (const level of ["screen", "ebook", "printer"]) {
      const res = await compress(engine, fixture("scanned.pdf"), level);
      expect(res.status).toBe(200);
      const file = join(out, `scanned-${level}.pdf`);
      writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
      expect(verifyFile(file, { expectPages: 2 }).ok).toBe(true);
    }
  });

  it("returns the original bytes when Ghostscript cannot make them smaller", async () => {
    const input = fixture("tiny.pdf");
    const res = await compress(engine, input);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-inkly-compressed")).toBe("false");
    expect(Buffer.from(await res.arrayBuffer()).equals(input)).toBe(true);
  });

  it("refuses malformed and non-PDF bodies with 422", async () => {
    for (const body of [fixture("malformed.pdf"), Buffer.from("not a pdf")]) {
      const res = await compress(engine, body);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "pdf_malformed" });
    }
  });

  it("refuses encrypted input with 422", async () => {
    const res = await compress(engine, fixture("encrypted.pdf"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "pdf_encrypted" });
  });

  it("refuses an unknown or missing level with 422", async () => {
    const res = await compress(engine, fixture("tiny.pdf"), "prepress");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_level" });
    const missing = await fetch(`${engine.url}/compress`, {
      method: "POST",
      body: fixture("tiny.pdf"),
    });
    expect(missing.status).toBe(422);
  });

  it("refuses a body above the size limit with 413", async () => {
    const small = await start({ PDF_ENGINE_MAX_BYTES: "1000" });
    extra.push(small);
    const res = await compress(small, fixture("10p.pdf"));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect((await compress(small, new Uint8Array(500))).status).toBe(422);

    const bytes = fixture("10p.pdf");
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const streamed = await fetch(`${small.url}/compress?level=ebook`, {
      method: "POST",
      body: chunked,
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
  });

  it("gives up with 504 when a request takes longer than the timeout", async () => {
    const hasty = await start({ PDF_ENGINE_TIMEOUT_MS: "50" });
    extra.push(hasty);
    const res = await compress(hasty, fixture("huge-image.pdf"));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "timeout" });
    expect((await fetch(`${hasty.url}/health`)).status).toBe(200);
  });
});

describe("other routes", () => {
  it("answers 404 for unknown paths and 405 for the wrong method", async () => {
    expect((await fetch(`${engine.url}/nope`)).status).toBe(404);
    expect((await fetch(`${engine.url}/compress?level=ebook`)).status).toBe(405);
  });
});
