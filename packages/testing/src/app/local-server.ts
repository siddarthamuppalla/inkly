import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LocalWorker {
  readonly baseUrl: string;
  readonly secret: string;
  readonly stop: () => void;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("no port"));
      });
    });
  });
}

function run(cmd: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  }
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited (${String(child.exitCode)})`);
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`wrangler dev did not answer ${url} within ${String(timeoutMs)} ms`);
}

/**
 * Builds the SPA, applies D1 migrations to a throwaway local state dir, and starts
 * `wrangler dev` with test hooks enabled behind a random per-run secret.
 */
export async function startLocalWorker(repoRoot: string, log: string[]): Promise<LocalWorker> {
  const apiDir = join(repoRoot, "workers/api");
  const wrangler = join(apiDir, "node_modules/.bin/wrangler");
  const state = mkdtempSync(join(tmpdir(), "verify-app-state-"));
  const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
  run("pnpm", ["--filter", "@inkly/web", "build"], repoRoot, env);
  run(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state], apiDir, env);

  const port = await freePort();
  const secret = randomBytes(24).toString("hex");
  const child = spawn(
    wrangler,
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      state,
      "--var",
      "TEST_HOOKS:enabled",
      "--var",
      `TEST_HOOKS_SECRET:${secret}`,
    ],
    { cwd: apiDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr.on("data", (d: Buffer) => log.push(d.toString()));

  const stop = () => {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    rmSync(state, { recursive: true, force: true });
  };
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  try {
    await waitForHealth(`${baseUrl}/health`, child, 60_000);
  } catch (err) {
    stop();
    throw err;
  }
  return { baseUrl, secret, stop };
}
