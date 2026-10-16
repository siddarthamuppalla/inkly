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
 * Seeds a fresh Tenant and owner through `/__test/seed` and signs the page in as them:
 * every later request from the page carries `Authorization: Bearer <token>`.
 */
export async function signedIn(
  ctx: JourneyContext,
  input: { email?: string; plan?: "free" | "pro" } = {},
): Promise<SeededUser> {
  const user = await seedUser(ctx, input);
  await ctx.page.setExtraHTTPHeaders({ authorization: `Bearer ${user.token}` });
  return user;
}
