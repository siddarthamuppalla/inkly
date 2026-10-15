import { describe, expect, it } from "vitest";

import app, { type Env } from "../src/index.ts";
import { hooks, latestCode, ORIGIN, outbox, post, uniqueEmail } from "./helpers.ts";

const SEND = "/api/auth/email-otp/send-verification-otp";

async function signInWithCode(email: string, origin = ORIGIN, bindings: Env = hooks) {
  const send = await app.request(
    `${origin}${SEND}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, type: "sign-in" }),
    },
    bindings,
  );
  expect(send.status).toBe(200);
  const otp = await latestCode(email);
  return app.request(
    `${origin}/api/auth/sign-in/email-otp`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, otp }),
    },
    bindings,
  );
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

interface MeBody {
  user: { id: string; email: string; name: string };
  activeTenant: { id: string; name: string; plan: string } | null;
  role: string | null;
  tenants: { id: string; name: string; role: string }[];
}

async function me(cookie: string, bindings: Env = hooks) {
  return app.request(`${ORIGIN}/api/me`, { headers: { cookie } }, bindings);
}

describe("sign in with an email code", () => {
  it("signs up a new email, creates their workspace with them as owner, and /api/me shows it", async () => {
    const email = uniqueEmail("ada");
    const res = await signInWithCode(email);
    expect(res.status).toBe(200);

    const meRes = await me(cookieHeader(res));
    expect(meRes.status).toBe(200);
    const body = await meRes.json<MeBody>();
    const name = email.split("@")[0] ?? "";
    expect(body.user).toMatchObject({ email, name });
    expect(body.activeTenant).toMatchObject({ name: `${name}'s workspace`, plan: "free" });
    expect(body.activeTenant?.id).toMatch(/^ten_[0-9a-f]{32}$/);
    expect(body.role).toBe("owner");
    expect(body.tenants).toEqual([
      { id: body.activeTenant?.id, name: `${name}'s workspace`, plan: "free", role: "owner" },
    ]);
  });

  it("mails a 6-digit code to the Outbox", async () => {
    const email = uniqueEmail("code");
    await post(SEND, { email, type: "sign-in" });
    const [mail] = await outbox(email);
    expect(mail?.subject).toMatch(/^\d{6} is your Inkly sign-in code$/);
  });

  it("refuses a wrong code", async () => {
    const email = uniqueEmail("wrong");
    await post(SEND, { email, type: "sign-in" });
    const res = await post("/api/auth/sign-in/email-otp", { email, otp: "000000" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("sets an HttpOnly, SameSite=Lax session cookie, without Secure on local http", async () => {
    const res = await signInWithCode(uniqueEmail("cookie"));
    const session = res.headers.getSetCookie().find((c) => c.includes("session_token="));
    expect(session).toBeDefined();
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
    expect(session).not.toMatch(/;\s*Secure/i);
  });

  it("sets a Secure cookie over https", async () => {
    const res = await signInWithCode(uniqueEmail("secure"), "https://inkly.test");
    const session = res.headers.getSetCookie().find((c) => c.includes("session_token="));
    expect(session).toMatch(/;\s*Secure/i);
    expect(session).toMatch(/;\s*HttpOnly/i);
    expect(session).toMatch(/;\s*SameSite=Lax/i);
  });

  it("keeps the session in D1, so a fresh auth instance still knows it", async () => {
    const res = await signInWithCode(uniqueEmail("d1"));
    const fresh: Env = { ...hooks };
    expect((await me(cookieHeader(res), fresh)).status).toBe(200);
  });

  it("signs out: the cookie stops working", async () => {
    const res = await signInWithCode(uniqueEmail("out"));
    const cookie = cookieHeader(res);
    const out = await app.request(
      `${ORIGIN}/api/auth/sign-out`,
      { method: "POST", headers: { cookie, origin: ORIGIN } },
      hooks,
    );
    expect(out.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
  });

  it("returns 401 from /api/me when signed out", async () => {
    expect((await app.request(`${ORIGIN}/api/me`, {}, hooks)).status).toBe(401);
  });
});

describe("magic link", () => {
  it("mails a link that signs the user in", async () => {
    const email = uniqueEmail("link");
    const send = await post("/api/auth/sign-in/magic-link", { email, callbackURL: "/" });
    expect(send.status).toBe(200);
    const url = /https?:\/\/\S+/.exec((await outbox(email))[0]?.text ?? "")?.[0];
    expect(url).toContain("/api/auth/magic-link/verify?token=");
    const verify = await app.request(url ?? "", { redirect: "manual" }, hooks);
    expect(verify.status).toBe(302);
    expect((await me(cookieHeader(verify))).status).toBe(200);
  });
});

describe("sign-in code rate limit", () => {
  it("returns 429 on the 6th code request for one email within 10 minutes", async () => {
    const email = uniqueEmail("burst");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await post(SEND, { email, type: "sign-in" })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const res = await post(SEND, { email: email.toUpperCase(), type: "sign-in" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect((await post(SEND, { email: uniqueEmail("other"), type: "sign-in" })).status).toBe(200);
  });

  it("counts magic-link requests against the same limit", async () => {
    const email = uniqueEmail("mixed");
    for (let i = 0; i < 5; i++) await post(SEND, { email, type: "sign-in" });
    expect((await post("/api/auth/sign-in/magic-link", { email })).status).toBe(429);
  });
});

describe("Google sign-in", () => {
  it("is not offered and does not 5xx when GOOGLE_CLIENT_ID/SECRET are unset", async () => {
    const options = await app.request(`${ORIGIN}/api/auth-options`, {}, hooks);
    expect(await options.json()).toEqual({ google: false });
    const res = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("is offered and redirects to Google when configured", async () => {
    const google: Env = {
      ...hooks,
      GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: crypto.randomUUID(),
    };
    const options = await app.request(`${ORIGIN}/api/auth-options`, {}, google);
    expect(await options.json()).toEqual({ google: true });
    const res = await app.request(
      `${ORIGIN}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      },
      google,
    );
    expect(res.status).toBe(200);
    const { url } = await res.json<{ url: string }>();
    expect(new URL(url).hostname).toBe("accounts.google.com");
  });
});

describe("/api/auth/* surface", () => {
  it("exposes only the sign-in endpoints; organization changes are not reachable", async () => {
    const res = await post("/api/auth/organization/create", { name: "x", slug: "x" });
    expect(res.status).toBe(404);
    expect((await app.request(`${ORIGIN}/api/auth/ok`, {}, hooks)).status).toBe(404);
  });
});
