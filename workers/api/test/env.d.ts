import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/index.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      /** Base64 of files in fixtures/pdfs, keyed by file name (see vitest.config.ts). */
      TEST_FIXTURES: Record<string, string>;
      /** verify-pdf and pdftotext, run in Node (see vitest.config.ts). */
      PDF_TOOLS: Fetcher;
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index.ts");
    }
  }
}
