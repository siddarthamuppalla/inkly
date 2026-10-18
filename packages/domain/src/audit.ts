// Audit trail hash chain (ADR-0006). The only implementation: the Envelope DO, the API's
// chain check and verify-signing all call it. Pure (no WebCrypto), so it runs unchanged in
// Workers, Node and the browser.

export const AUDIT_ACTIONS = [
  "created",
  "sent",
  "notified",
  "viewed",
  "code_sent",
  "verified",
  "signed",
  "declined",
  "voided",
  "expired",
  "reminded",
  "completed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditSubjectType = "envelope";

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What one audit event commits to; `hash` covers exactly these fields. */
export interface AuditEventBody {
  readonly tenantId: string;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: string;
  readonly seq: number;
  /** A UserId for a Member, a RecipientId for a signer, or "system" for the Workflow. */
  readonly actor: string;
  readonly action: AuditAction;
  readonly detail: { readonly [key: string]: JsonValue };
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly at: number;
}

export interface AuditEvent extends AuditEventBody {
  readonly prevHash: string;
  readonly hash: string;
}

/** The `prev_hash` of every subject's first event. */
export const GENESIS = "0".repeat(64);

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${(value as readonly JsonValue[]).map(canonicalJson).join(",")}]`;
  }
  const record = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k] ?? null)}`).join(",")}}`;
}

function bodyOf(event: AuditEventBody): JsonValue {
  return {
    tenantId: event.tenantId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    seq: event.seq,
    actor: event.actor,
    action: event.action,
    detail: event.detail,
    ip: event.ip,
    userAgent: event.userAgent,
    at: event.at,
  };
}

/** hex(sha256(prevHash + "\n" + canonical_json(event))). */
export function auditHash(prevHash: string, event: AuditEventBody): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(bodyOf(event))}`);
}

/** `event` with its place in the chain after `prevHash`. */
export function chained(prevHash: string, event: AuditEventBody): AuditEvent {
  return { ...event, prevHash, hash: auditHash(prevHash, event) };
}

export interface ChainCheck {
  readonly valid: boolean;
  /** The last event's hash (GENESIS for no events). */
  readonly head: string;
  /** The first `seq` whose link or hash does not hold. */
  readonly brokenAt?: number;
}

/** Recomputes every hash in `seq` order; one changed field breaks the chain from that event on. */
export function verifyChain(events: readonly AuditEvent[]): ChainCheck {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const event of events) {
    if (
      event.seq !== expectedSeq ||
      event.prevHash !== prev ||
      event.hash !== auditHash(prev, event)
    ) {
      return { valid: false, head: events.at(-1)?.hash ?? GENESIS, brokenAt: event.seq };
    }
    prev = event.hash;
    expectedSeq++;
  }
  return { valid: true, head: prev };
}

function utf8(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return out;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of `text` as UTF-8, lowercase hex (FIPS 180-4). */
export function sha256Hex(text: string): string {
  const bytes = utf8(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 2 ** 32);
  for (const word of [high, bitLength >>> 0]) {
    bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  }
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64).fill(0);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i++) {
      const at = block + i * 4;
      w[i] =
        (((bytes[at] ?? 0) << 24) |
          ((bytes[at + 1] ?? 0) << 16) |
          ((bytes[at + 2] ?? 0) << 8) |
          (bytes[at + 3] ?? 0)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}
