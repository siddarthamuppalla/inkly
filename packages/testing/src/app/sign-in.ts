import type { JourneyContext } from "./journeys.ts";

export interface SignedIn {
  readonly tenantId: string;
  readonly userId: string;
  readonly token: string;
}

/** Seeds a fresh Tenant and User and makes every request from the page carry its session. */
export async function signedIn(ctx: JourneyContext): Promise<SignedIn> {
  if (ctx.secret === undefined) throw new Error("signing in needs the target's test-hooks secret");
  const res = await ctx.page.request.post(new URL("/__test/seed", ctx.baseUrl).toString(), {
    headers: { "x-test-hooks-secret": ctx.secret },
  });
  if (res.status() !== 201) throw new Error(`POST /__test/seed returned ${String(res.status())}`);
  const seeded = (await res.json()) as SignedIn;
  await ctx.page.setExtraHTTPHeaders({ authorization: `Bearer ${seeded.token}` });
  return seeded;
}
