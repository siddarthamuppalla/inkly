import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const FIXTURES = [
  "10p.pdf",
  "tiny.pdf",
  "rotated.pdf",
  "encrypted.pdf",
  "encrypted-objstm.pdf",
  "malformed.pdf",
  "forms.pdf",
];

const NODE = ["--disable-warning=ExperimentalWarning"];

/** A fresh seal key pair per run, from the same script previews use (scripts/seal-key.mjs). */
function sealKey(): { SEAL_PRIVATE_KEY: string; SEAL_CERTIFICATE: string } {
  const r = spawnSync("node", [...NODE, "../../scripts/seal-key.mjs", "--json"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`seal-key.mjs failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { SEAL_PRIVATE_KEY: string; SEAL_CERTIFICATE: string };
}

/**
 * PDF_TOOLS, a test-only service binding that runs in Node: workerd cannot run pyHanko or
 * poppler, so tests POST `{ pdf (base64), certificate, expectPages }` and get back the
 * `verify-pdf --signed` result and the page text.
 */
async function pdfTools(request: Request): Promise<Response> {
  const input = await request.json<{ pdf: string; certificate: string; expectPages: number }>();
  const dir = mkdtempSync(join(tmpdir(), "inkly-api-pdf-"));
  try {
    const pdf = join(dir, "sealed.pdf");
    const cert = join(dir, "seal.pem");
    writeFileSync(
      pdf,
      Uint8Array.from(atob(input.pdf), (c) => c.charCodeAt(0)),
    );
    writeFileSync(cert, input.certificate);
    const verify = spawnSync(
      "node",
      [
        ...NODE,
        "../../packages/testing/bin/verify-pdf.ts",
        pdf,
        "--signed",
        cert,
        "--expect-pages",
        String(input.expectPages),
      ],
      { encoding: "utf8" },
    );
    const text = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8" });
    return Response.json({
      ok: verify.status === 0,
      output: `${verify.stdout}${verify.stderr}`,
      text: text.stdout,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const fixtures = Object.fromEntries(
    FIXTURES.map((f) => [f, readFileSync(`../../fixtures/pdfs/${f}`).toString("base64")]),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_FIXTURES: fixtures,
            // Random per run so no secret-shaped literal lives in the repo (gitleaks).
            BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            EMAIL_PROVIDER: "outbox",
            ...sealKey(),
          },
          serviceBindings: { PDF_TOOLS: pdfTools },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
