import { redirect, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";

import { api, fetchMe, type Me } from "./api.ts";

export const SIGNED_IN_ROUTE = "signed-in";

/** Auth guard: signed-out visitors go to /sign-in and come back afterwards. */
export async function requireMe({ request }: LoaderFunctionArgs): Promise<Me | Response> {
  const me = await fetchMe();
  if (me) return me;
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return redirect(next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`);
}

/** The signed-in User inside guarded routes; undefined on public pages such as /design. */
export function useMe(): Me | undefined {
  return useRouteLoaderData<Me>(SIGNED_IN_ROUTE);
}

/** Only same-site paths are followed after sign-in. */
export function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signOut(): Promise<void> {
  await api("/api/auth/sign-out", { method: "POST", json: {} });
  window.location.assign("/sign-in");
}

export async function switchTenant(tenantId: string): Promise<void> {
  await api("/api/me/active-tenant", { method: "POST", json: { tenantId } });
  window.location.assign("/");
}
