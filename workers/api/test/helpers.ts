import { env } from "cloudflare:workers";

import app, { type Env } from "../src/index.ts";

// Random per run so no secret-shaped literal lives in the repo (gitleaks).
export const SECRET = crypto.randomUUID();
export const hooks: Env = { ...env, TEST_HOOKS: "enabled", TEST_HOOKS_SECRET: SECRET };
export const ORIGIN = "http://inkly.test";

export interface Seeded {
  tenantId: string;
  userId: string;
  email: string;
  token: string;
}

export async function seed(
  input: { email?: string; name?: string; plan?: "free" | "pro" } = {},
  bindings: Env = hooks,
): Promise<Seeded> {
  const res = await app.request(
    `${ORIGIN}/__test/seed`,
    {
      method: "POST",
      headers: { "x-test-hooks-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    bindings,
  );
  if (res.status !== 201) throw new Error(`seed returned ${String(res.status)}`);
  return res.json<Seeded>();
}

/** A request as `who` (bearer token). JSON bodies get a content-type. */
export function as(
  who: { token: string },
  path: string,
  init: RequestInit = {},
  bindings: Env = hooks,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${who.token}`);
  if (typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return Promise.resolve(app.request(`${ORIGIN}${path}`, { ...init, headers }, bindings));
}

export function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve(
    app.request(
      `${ORIGIN}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
        body: JSON.stringify(body),
      },
      hooks,
    ),
  );
}

export interface OutboxMessage {
  to: string;
  subject: string;
  text: string;
}

export async function outbox(to: string): Promise<OutboxMessage[]> {
  const res = await app.request(
    `${ORIGIN}/__test/outbox?to=${encodeURIComponent(to)}`,
    { headers: { "x-test-hooks-secret": SECRET } },
    hooks,
  );
  return (await res.json<{ messages: OutboxMessage[] }>()).messages;
}

export async function accessLog(tenantId: string) {
  const res = await app.request(
    `${ORIGIN}/__test/access-log?tenant=${tenantId}`,
    { headers: { "x-test-hooks-secret": SECRET } },
    hooks,
  );
  return (await res.json<{ entries: { action: string; status: number; resource: string }[] }>())
    .entries;
}

export function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}

/** The latest 6-digit code mailed to `email`. */
export async function latestCode(email: string): Promise<string> {
  const [latest] = await outbox(email);
  const code = /\b(\d{6})\b/.exec(latest?.text ?? "")?.[1];
  if (!code) throw new Error(`no code in the outbox for ${email}`);
  return code;
}
