import { createServer, type Server } from "node:http";

export type FixtureMode = "clean" | "console-error" | "server-error" | "a11y-violation";

const DOC = '<!doctype html><html lang="en">';
const PAGES: Record<FixtureMode, string> = {
  clean: `${DOC}<title>clean</title><p>ok</p>`,
  "console-error": `${DOC}<title>console</title><script>console.error('fixture console error')</script>`,
  "server-error": `${DOC}<title>5xx</title><script>fetch('/boom')</script>`,
  "a11y-violation": `${DOC}<title>a11y</title><p style="color:#c8c8c8;background:#fff">faint text</p><button></button>`,
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
