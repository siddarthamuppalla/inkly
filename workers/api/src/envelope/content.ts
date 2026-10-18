import type { TenantId } from "@inkly/domain";
import { openVersion, type EnvelopeRow } from "@inkly/storage";

import type { Env } from "../env.ts";

/** How long after completion a Recipient's link still downloads the signed PDF (ADR-0006). */
export const SIGNED_PDF_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Version a reader of `envelope` gets: the sealed one once completed, else the pinned one. */
export function envelopeVersion(envelope: EnvelopeRow): number {
  return envelope.status === "completed" && envelope.finalVersion !== null
    ? envelope.finalVersion
    : envelope.version;
}

/** The Version's bytes as an inline PDF download named after the Envelope. */
export async function envelopePdf(
  tenantId: TenantId,
  env: Env,
  envelope: EnvelopeRow,
  n: number,
): Promise<Response | null> {
  const opened = await openVersion(tenantId, env, envelope.documentId, n);
  if (!opened) return null;
  const filename = `${envelope.title}.pdf`.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(opened.object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(opened.object.size),
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
}

/**
 * The signed PDF for a Recipient's link (`GET /api/sign/:token/content`, T3.3): the sealed
 * Version of a completed Envelope for SIGNED_PDF_DAYS after completion, otherwise null.
 * The caller has resolved the token in packages/auth and logs the access.
 */
export function signedPdf(
  tenantId: TenantId,
  env: Env,
  envelope: EnvelopeRow,
  now = Date.now(),
): Promise<Response | null> {
  const { status, finalVersion, completedAt } = envelope;
  if (status !== "completed" || finalVersion === null || completedAt === null) {
    return Promise.resolve(null);
  }
  if (now > completedAt + SIGNED_PDF_DAYS * DAY_MS) return Promise.resolve(null);
  return envelopePdf(tenantId, env, envelope, finalVersion);
}
