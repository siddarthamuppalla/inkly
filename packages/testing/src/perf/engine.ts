import { spawn } from "node:child_process";
import { join } from "node:path";

export interface LocalEngine {
  readonly url: string;
  stop(): void;
}

/** Starts `containers/pdf-engine` on a free port and waits for its listening line. */
export function startEngine(repoRoot: string): Promise<LocalEngine> {
  const server = join(repoRoot, "containers/pdf-engine/src/server.ts");
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", server], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const port = /listening on (\d+)/.exec(seen)?.[1];
      if (port !== undefined) {
        resolve({ url: `http://127.0.0.1:${port}`, stop: () => child.kill() });
      }
    });
    child.on("exit", (code) => {
      reject(new Error(`pdf-engine exited with ${String(code)} before listening`));
    });
  });
}
