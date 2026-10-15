import { createServer, type Server } from "node:http";

export type FixtureMode = "clean" | "console-error" | "server-error";

const PAGES: Record<FixtureMode, string> = {
  clean: "<!doctype html><title>clean</title><p>ok</p>",
  "console-error":
    "<!doctype html><title>console</title><script>console.error('fixture console error')</script>",
  "server-error": "<!doctype html><title>5xx</title><script>fetch('/boom')</script>",
};

/** A tiny HTTP server serving one J-FAIL fixture page, used only by `--self-test`. */
export function startFixtureServer(mode: FixtureMode): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (req.url === "/boom") {
      res.writeHead(500, { "content-type": "text/plain" }).end("fixture 5xx");
      return;
    }
    if (req.url === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGES[mode]);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${String(port)}`, server });
    });
  });
}
