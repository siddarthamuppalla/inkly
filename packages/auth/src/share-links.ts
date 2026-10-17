import {
  AppError,
  shareLinkStatus,
  type DocumentId,
  type ShareLinkId,
  type TenantId,
} from "@inkly/domain";
import { countWindowHit, findShareLinkByTokenHash } from "@inkly/storage/auth";

import type { AuthEnv } from "./env.ts";
import { newId } from "./ids.ts";

// T2.3: the only place a Share-link token becomes a TenantId (ADR-0004). Tokens carry
// 256 random bits and only their sha256 is stored; passwords are PBKDF2-SHA256 with a
// per-link salt. An unlocked link is remembered by a signed, short-lived grant.

const encoder = new TextEncoder();
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Workers caps PBKDF2 at 100,000 iterations; we use the cap. */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

export const UNLOCK_ATTEMPT_LIMIT = 10;
export const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
export const SHARE_GRANT_TTL_MS = 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  try {
    const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function mintShareLinkId(): ShareLinkId {
  return newId("shl") as ShareLinkId;
}

/** A new link token (shown once, in the URL) and the sha256 that is stored. */
export async function mintShareToken(): Promise<{ token: string; tokenHash: string }> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  return { token, tokenHash: await sha256Hex(token) };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`, salt and hash base64url. */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${String(PBKDF2_ITERATIONS)}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, saltText, hashText] = stored.split("$");
  const iterations = Number(rounds);
  const salt = fromBase64url(saltText ?? "");
  const expected = fromBase64url(hashText ?? "");
  if (scheme !== "pbkdf2-sha256" || !Number.isSafeInteger(iterations) || !salt || !expected) {
    return false;
  }
  return equalBytes(await pbkdf2(password, salt, iterations), expected);
}

/** A link that opens right now, with the TenantId that owns it. */
export interface OpenShareLink {
  readonly kind: "open";
  readonly tenantId: TenantId;
  readonly linkId: ShareLinkId;
  readonly documentId: DocumentId;
  readonly allowDownload: boolean;
  readonly passwordHash: string | null;
}

/** A link that exists but no longer opens (expired, revoked, or its Document is in Trash). */
export interface GoneShareLink {
  readonly kind: "gone";
  readonly tenantId: TenantId;
  readonly linkId: ShareLinkId;
  readonly documentId: DocumentId;
}

/** What a token names: an open link, a gone one (still logged to its Tenant), or nothing. */
export async function resolveShareLink(
  env: AuthEnv,
  token: string,
  now: number,
): Promise<OpenShareLink | GoneShareLink | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const row = await findShareLinkByTokenHash(env, await sha256Hex(token));
  if (!row) return null;
  const tenantId = row.tenantId as TenantId;
  const linkId = row.linkId as ShareLinkId;
  const documentId = row.documentId as DocumentId;
  if (row.documentDeletedAt !== null || shareLinkStatus(row, now) !== "active") {
    return { kind: "gone", tenantId, linkId, documentId };
  }
  return {
    kind: "open",
    tenantId,
    linkId,
    documentId,
    allowDownload: row.allowDownload === 1,
    passwordHash: row.passwordHash,
  };
}

/** Counts one unlock attempt; false once the link has had more than 10 in 10 minutes. */
export async function unlockAttemptAllowed(env: AuthEnv, linkId: ShareLinkId): Promise<boolean> {
  const count = await countWindowHit(env, `share-unlock/${linkId}`, UNLOCK_WINDOW_MS);
  return count <= UNLOCK_ATTEMPT_LIMIT;
}

async function grantSignature(env: AuthEnv, link: OpenShareLink, exp: number): Promise<Uint8Array> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new AppError("internal", "BETTER_AUTH_SECRET is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = `share-unlock|${link.linkId}|${String(exp)}|${link.passwordHash ?? ""}`;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** A grant proving this browser entered the link's password, valid for one hour. */
export async function issueShareGrant(env: AuthEnv, link: OpenShareLink, now: number) {
  const exp = now + SHARE_GRANT_TTL_MS;
  const signature = await grantSignature(env, link, exp);
  return {
    value: `${String(exp)}.${base64url(signature)}`,
    maxAgeSeconds: SHARE_GRANT_TTL_MS / 1000,
  };
}

/** True when the link has no password, or `grant` is a live grant issued for this link. */
export async function shareLinkUnlocked(
  env: AuthEnv,
  link: OpenShareLink,
  grant: string | undefined,
  now: number,
): Promise<boolean> {
  if (link.passwordHash === null) return true;
  const [expText, sigText] = (grant ?? "").split(".");
  const exp = Number(expText);
  const signature = fromBase64url(sigText ?? "");
  if (!Number.isSafeInteger(exp) || exp <= now || !signature) return false;
  return equalBytes(await grantSignature(env, link, exp), signature);
}
