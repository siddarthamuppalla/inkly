import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PerfOp } from "./ops.ts";

// verify-perf --url: the page ops timed through the deployed API (T1.3b), request to
// response, so the numbers include the network, auth, R2 and D1 as a user sees them.

interface Seeded {
  readonly token: string;
}

async function expectStatus(res: Response, status: number, what: string): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  if (res.status !== status) {
    throw new Error(`${what} answered ${String(res.status)}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Seeds a Pro owner (its page-op Limit covers every timed run), uploads 50p.pdf and
 * 10p.pdf, and returns the four page ops against them.
 */
export async function remoteOps(
  repoRoot: string,
  baseUrl: string,
  secret: string,
): Promise<PerfOp[]> {
  const url = (path: string) => new URL(path, baseUrl).toString();
  const seeded = (await expectStatus(
    await fetch(url("/__test/seed"), {
      method: "POST",
      headers: { "x-test-hooks-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    }),
    201,
    "POST /__test/seed",
  )) as Seeded;
  const auth = { authorization: `Bearer ${seeded.token}` };

  const upload = async (name: string): Promise<string> => {
    const body = await expectStatus(
      await fetch(url(`/api/documents?filename=${name}`), {
        method: "POST",
        headers: { ...auth, "content-type": "application/pdf" },
        body: readFileSync(join(repoRoot, "fixtures/pdfs", name)),
      }),
      201,
      `upload ${name}`,
    );
    return (body as { document: { id: string } }).document.id;
  };
  const p50 = await upload("50p.pdf");
  const p10 = await upload("10p.pdf");

  const op = (
    name: string,
    path: string,
    req: unknown,
    check: (body: unknown) => boolean,
  ): PerfOp => ({
    name,
    async run() {
      const res = await fetch(url(`/api/documents${path}`), {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      const body = await expectStatus(res, 201, `POST ${path}`);
      if (!check(body)) throw new Error(`benchmark op did no work: ${name}`);
    },
  });
  const all = Array.from({ length: 50 }, (_, i) => i + 1);
  const pages = (body: unknown) => (body as { document: { pages: number } }).document.pages;
  return [
    op("api merge 50p+10p", "/merge", { documentIds: [p50, p10] }, (b) => pages(b) === 60),
    op(
      "api split 50p into 5",
      `/${p50}/split`,
      { ranges: [0, 1, 2, 3, 4].map((i) => ({ from: i * 10 + 1, to: i * 10 + 10 })) },
      (b) => (b as { documents: unknown[] }).documents.length === 5,
    ),
    op(
      "api rotate 50p all pages",
      `/${p50}/rotate`,
      { pages: all, degrees: 90 },
      (b) => pages(b) === 50,
    ),
    op(
      "api reorder 50p reversed",
      `/${p50}/reorder`,
      { order: [...all].reverse() },
      (b) => pages(b) === 50,
    ),
  ];
}
