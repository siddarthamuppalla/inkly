import { getRandom } from "@cloudflare/containers";
import { testHooksOn } from "@inkly/auth";
import type { CompressLevel } from "@inkly/domain";

import type { JobsEnv } from "./env.ts";

// The consumer's view of pdf-engine (containers/pdf-engine/README.md). Tests pass a fake.

/** The smaller PDF, or `compressed: false` when the engine could not make it smaller. */
export type Compressed =
  { readonly compressed: true; readonly body: Uint8Array } | { readonly compressed: false };

export interface Engine {
  compress(
    pdf: ReadableStream | Uint8Array,
    bytes: number,
    level: CompressLevel,
  ): Promise<Compressed>;
}

/** The engine refused the input (422/413): retrying cannot help, so the Job fails. */
export class EngineRefusal extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "EngineRefusal";
    this.code = code;
  }
}

/** Container instances the consumer spreads Jobs over; keep at most `max_instances` in wrangler.jsonc. */
const INSTANCES = 2;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function httpEngine(fetcher: Fetcher, base: string): Engine {
  return {
    async compress(pdf, bytes, level) {
      const res = await fetcher(`${base}/compress?level=${level}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "content-length": String(bytes) },
        body: pdf,
      });
      if (res.status === 200) {
        if (res.headers.get("x-inkly-compressed") === "true") {
          return { compressed: true, body: new Uint8Array(await res.arrayBuffer()) };
        }
        // The engine echoes the input; reading it would only fill the Worker's memory.
        await res.body?.cancel();
        return { compressed: false };
      }
      const reply: { error?: string } = await res.json<{ error?: string }>().catch(() => ({}));
      const code = reply.error;
      if (res.status === 413 || res.status === 422) throw new EngineRefusal(code ?? "refused");
      throw new Error(`pdf-engine answered ${String(res.status)} ${code ?? ""}`.trim());
    },
  };
}

/** pdf-engine for this environment: the Container, or PDF_ENGINE_URL in local dev. */
export function engineFor(env: JobsEnv): Engine {
  if (env.PDF_ENGINE_URL !== undefined && testHooksOn(env)) {
    return httpEngine((url, init) => fetch(url, init), env.PDF_ENGINE_URL.replace(/\/$/, ""));
  }
  return httpEngine(
    async (url, init) => (await getRandom(env.PDF_ENGINE, INSTANCES)).fetch(url, init),
    "http://pdf-engine",
  );
}
