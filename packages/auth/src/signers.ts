import {
  SIGNER_GRANT_TTL_MS,
  SIGNING_CODE,
  type DocumentId,
  type EnvelopeId,
  type RecipientId,
  type TenantId,
} from "@inkly/domain";
import { countWindowHit, findRecipientByTokenHash } from "@inkly/storage/auth";

import type { AuthEnv } from "./env.ts";
import {
  base64url,
  equalBytes,
  fromBase64url,
  hmacSha256,
  mintShareToken,
  sha256Hex,
  TOKEN_PATTERN,
} from "./share-links.ts";

// Signer links (ADR-0006, T3.1/T3.3). A token carries 256 random bits like a Share-link token,
// and only its sha256 is stored, in recipients.token_hash. This is the only place a signer
// token becomes a TenantId. A right Signing code earns a signed 1-hour grant bound to the
// Recipient and to the link it was entered on.

/** A new signer token (sent once, in the `/sign/{token}` link) and the sha256 that is stored. */
export function mintSignerToken(): Promise<{ token: string; tokenHash: string }> {
  return mintShareToken();
}

interface SignerBase {
  readonly tenantId: TenantId;
  readonly envelopeId: EnvelopeId;
  readonly recipientId: RecipientId;
  readonly documentId: DocumentId;
}

/** A link whose Recipient still has to sign or decline, with the TenantId that owns it. */
export interface OpenSigner extends SignerBase {
  readonly kind: "open";
  readonly version: number;
  readonly tokenHash: string;
}

/** The link of a Recipient who signed: it shows the done state, never the document. */
export interface SignedSigner extends SignerBase {
  readonly kind: "signed";
  readonly completed: boolean;
}

/** A link that exists but no longer opens (voided, declined, expired); still logged to its Tenant. */
export interface GoneSigner extends SignerBase {
  readonly kind: "gone";
}

export type ResolvedSigner = OpenSigner | SignedSigner | GoneSigner;

/** What a signer token names right now, or null for a malformed or unknown token. */
export async function resolveSignerToken(
  env: AuthEnv,
  token: string,
  now: number,
): Promise<ResolvedSigner | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await findRecipientByTokenHash(env, tokenHash);
  if (!row) return null;
  const base: SignerBase = {
    tenantId: row.tenantId as TenantId,
    envelopeId: row.envelopeId as EnvelopeId,
    recipientId: row.recipientId as RecipientId,
    documentId: row.documentId as DocumentId,
  };
  const signing = row.envelopeStatus === "sent" && (row.expiresAt ?? Infinity) > now;
  const finishing = row.envelopeStatus === "completing" || row.envelopeStatus === "completed";
  if (row.recipientStatus === "signed" && (signing || finishing)) {
    return { ...base, kind: "signed", completed: row.envelopeStatus === "completed" };
  }
  const pending = row.role === "signer" && ["sent", "viewed"].includes(row.recipientStatus);
  if (!signing || !pending) return { ...base, kind: "gone" };
  return { ...base, kind: "open", version: row.version, tokenHash };
}

/** Counts one Signing-code send; false once the Recipient has had more than 5 in 10 minutes. */
export async function signingCodeSendAllowed(
  env: AuthEnv,
  recipientId: RecipientId,
): Promise<boolean> {
  const count = await countWindowHit(env, `signing-code/${recipientId}`, SIGNING_CODE.sendWindowMs);
  return count <= SIGNING_CODE.maxSends;
}

async function codeHash(env: AuthEnv, recipientId: RecipientId, code: string): Promise<string> {
  return base64url(await hmacSha256(env, `signing-code|${recipientId}|${code}`));
}

/** Six uniformly random digits, and the keyed hash that is stored instead of them. */
export async function mintSigningCode(
  env: AuthEnv,
  recipientId: RecipientId,
): Promise<{ code: string; codeHash: string }> {
  const limit = 4_294_000_000; // the largest multiple of 10^6 below 2^32, so no digit is favoured
  let n: number;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit;
  } while (n >= limit);
  const code = String(n % 1_000_000).padStart(6, "0");
  return { code, codeHash: await codeHash(env, recipientId, code) };
}

export async function signingCodeMatches(
  env: AuthEnv,
  recipientId: RecipientId,
  code: string,
  stored: string,
): Promise<boolean> {
  const expected = fromBase64url(stored);
  const actual = fromBase64url(await codeHash(env, recipientId, code));
  return expected !== null && actual !== null && equalBytes(actual, expected);
}

function grantSignature(env: AuthEnv, signer: OpenSigner, exp: number): Promise<Uint8Array> {
  return hmacSha256(
    env,
    `signer-verified|${signer.recipientId}|${signer.tokenHash}|${String(exp)}`,
  );
}

/** A grant proving this browser entered the Recipient's Signing code, valid for one hour. */
export async function issueSignerGrant(env: AuthEnv, signer: OpenSigner, now: number) {
  const exp = now + SIGNER_GRANT_TTL_MS;
  const signature = await grantSignature(env, signer, exp);
  return {
    value: `${String(exp)}.${base64url(signature)}`,
    maxAgeSeconds: SIGNER_GRANT_TTL_MS / 1000,
  };
}

/** True when `grant` is a live grant issued for this Recipient on this link. */
export async function signerVerified(
  env: AuthEnv,
  signer: OpenSigner,
  grant: string | undefined,
  now: number,
): Promise<boolean> {
  const [expText, sigText] = (grant ?? "").split(".");
  const exp = Number(expText);
  const signature = fromBase64url(sigText ?? "");
  if (!Number.isSafeInteger(exp) || exp <= now || !signature) return false;
  return equalBytes(await grantSignature(env, signer, exp), signature);
}
