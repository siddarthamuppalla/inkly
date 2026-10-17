import type { JourneyContext } from "./journeys.ts";

export interface SeededUser {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

async function seedUser(
  ctx: JourneyContext,
  input: { email?: string; plan?: "free" | "pro" } = {},
): Promise<SeededUser> {
  if (ctx.secret === undefined) {
    throw new Error("this journey needs the test-hooks secret (--secret or local wrangler dev)");
  }
  const res = await ctx.page.request.post(new URL("/__test/seed", ctx.baseUrl).toString(), {
    headers: { "x-test-hooks-secret": ctx.secret },
    data: input,
  });
  if (res.status() !== 201) throw new Error(`POST /__test/seed returned ${String(res.status())}`);
  return (await res.json()) as SeededUser;
}

/**
 * Signs the page's browser context in with an emailed code, as the sign-in page does, so it
 * holds a session cookie. Browsers send cookies, not extra headers, on a WebSocket upgrade.
 */
async function signInCookie(ctx: JourneyContext, email: string): Promise<void> {
  const at = (path: string) => new URL(path, ctx.baseUrl).toString();
  // Signed in already, the auth handler checks the Origin of a POST, as a browser sends it.
  const headers = { origin: new URL(ctx.baseUrl).origin };
  const sent = await ctx.page.request.post(at("/api/auth/email-otp/send-verification-otp"), {
    data: { email, type: "sign-in" },
    headers,
  });
  if (!sent.ok()) throw new Error(`sending a sign-in code returned ${String(sent.status())}`);
  const outbox = await ctx.page.request.get(at(`/__test/outbox?to=${encodeURIComponent(email)}`), {
    headers: { "x-test-hooks-secret": ctx.secret ?? "" },
  });
  const body = (await outbox.json()) as { messages?: { text: string }[] };
  const otp = /\b(\d{6})\b/.exec(body.messages?.[0]?.text ?? "")?.[1] ?? "";
  const signedIn = await ctx.page.request.post(at("/api/auth/sign-in/email-otp"), {
    data: { email, otp },
    headers,
  });
  if (!signedIn.ok()) throw new Error(`code sign-in returned ${String(signedIn.status())}`);
}

/**
 * Seeds a fresh Tenant and owner through `/__test/seed` and signs the page in as them:
 * every later request from the page carries `Authorization: Bearer <token>`, and the
 * context holds their session cookie for the DocSession WebSocket.
 */
export async function signedIn(
  ctx: JourneyContext,
  input: { email?: string; plan?: "free" | "pro" } = {},
): Promise<SeededUser> {
  const user = await seedUser(ctx, input);
  await ctx.page.setExtraHTTPHeaders({ authorization: `Bearer ${user.token}` });
  await signInCookie(ctx, user.email);
  return user;
}
