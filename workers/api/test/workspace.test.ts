import type { TenantId } from "@inkly/domain";
import { setTenantPlan } from "@inkly/storage";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { accessLog, as, outbox, seed, uniqueEmail, type Seeded } from "./helpers.ts";

interface MeBody {
  activeTenant: { id: string; name: string } | null;
  role: string | null;
  tenants: { id: string; role: string }[];
}

async function me(who: Seeded) {
  return (await as(who, "/api/me")).json<MeBody>();
}

function invite(who: Seeded, email: string, role = "editor") {
  return as(who, "/api/tenant/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

async function invitationIdIn(email: string): Promise<string> {
  const [mail] = await outbox(email);
  const id = /\/invitations\/([A-Za-z0-9_-]+)/.exec(mail?.text ?? "")?.[1];
  if (!id) throw new Error(`no invitation link mailed to ${email}`);
  return id;
}

/** An owner of a Pro tenant and a second User who has joined it as an editor. */
async function twoMemberTenant() {
  const owner = await seed({ plan: "pro" });
  const email = uniqueEmail("joiner");
  expect((await invite(owner, email)).status).toBe(201);
  const joiner = await seed({ email });
  const id = await invitationIdIn(email);
  const accepted = await as(joiner, `/api/invitations/${id}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
  return { owner, joiner };
}

describe("invitations", () => {
  it("mails the invitee; accepting makes them a Member and their Active tenant", async () => {
    const owner = await seed({ plan: "pro" });
    const email = uniqueEmail("invitee");
    const res = await invite(owner, email);
    expect(res.status).toBe(201);

    const [mail] = await outbox(email);
    expect(mail?.subject).toMatch(/invited you to .+'s workspace on Inkly$/);
    expect(mail?.text).toMatch(/http:\/\/inkly\.test\/invitations\/inv_[0-9a-f]{32}/);

    const pending = await (
      await as(owner, "/api/tenant/members")
    ).json<{
      invitations: { email: string; role: string }[];
    }>();
    expect(pending.invitations).toEqual([expect.objectContaining({ email, role: "editor" })]);

    const invitee = await seed({ email });
    const id = await invitationIdIn(email);
    const accepted = await as(invitee, `/api/invitations/${id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ tenantId: owner.tenantId });

    const body = await me(invitee);
    expect(body.activeTenant?.id).toBe(owner.tenantId);
    expect(body.role).toBe("editor");
    expect(body.tenants.map((t) => t.role).sort()).toEqual(["editor", "owner"]);

    const members = await (
      await as(owner, "/api/tenant/members")
    ).json<{
      members: { email: string; role: string }[];
      invitations: unknown[];
    }>();
    expect(members.members.map((m) => [m.email, m.role])).toEqual([
      [owner.email, "owner"],
      [email, "editor"],
    ]);
    expect(members.invitations).toEqual([]);
  });

  it("refuses an invitation on a Free tenant with a typed limit_exceeded error", async () => {
    const owner = await seed();
    const res = await invite(owner, uniqueEmail("second"));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "limit_exceeded" });
  });

  it("refuses accepting into a tenant that has no free seat", async () => {
    const owner = await seed({ plan: "pro" });
    const email = uniqueEmail("late");
    await invite(owner, email);
    await setTenantPlan(owner.tenantId as TenantId, env, "free");
    const invitee = await seed({ email });
    const id = await invitationIdIn(email);
    const res = await as(invitee, `/api/invitations/${id}/accept`, { method: "POST" });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "limit_exceeded" });
    expect((await me(invitee)).tenants).toHaveLength(1);
  });

  it("does not let someone else accept an invitation", async () => {
    const owner = await seed({ plan: "pro" });
    const email = uniqueEmail("meant");
    await invite(owner, email);
    const stranger = await seed();
    const id = await invitationIdIn(email);
    const res = await as(stranger, `/api/invitations/${id}/accept`, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await me(stranger)).tenants).toHaveLength(1);
  });

  it("refuses invitations from editors and owner as an invited role", async () => {
    const { joiner } = await twoMemberTenant();
    expect((await invite(joiner, uniqueEmail("x"))).status).toBe(403);
    const owner = await seed({ plan: "pro" });
    expect((await invite(owner, uniqueEmail("y"), "owner")).status).toBe(422);
    expect((await invite(owner, "not-an-email")).status).toBe(422);
  });

  it("lets an owner remove a Member", async () => {
    const { owner, joiner } = await twoMemberTenant();
    const res = await as(owner, `/api/tenant/members/${joiner.userId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await me(joiner)).tenants.map((t) => t.id)).toEqual([joiner.tenantId]);
    expect((await me(joiner)).activeTenant?.id).toBe(joiner.tenantId);
  });
});

describe("switching the Active tenant", () => {
  it("acts on the new tenant only after a switch", async () => {
    const { owner, joiner } = await twoMemberTenant();
    // Accepting switched the joiner into the owner's tenant; switch back to their own.
    const create = (who: Seeded, title: string) =>
      as(who, "/v0/stub-docs", { method: "POST", body: JSON.stringify({ title }) });
    await create(owner, "shared doc");

    const back = await as(joiner, "/api/me/active-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId: joiner.tenantId }),
    });
    expect(back.status).toBe(200);
    expect((await me(joiner)).activeTenant?.id).toBe(joiner.tenantId);
    await create(joiner, "personal doc");
    const ownList = await (await as(joiner, "/v0/stub-docs")).json<{ docs: { title: string }[] }>();
    expect(ownList.docs.map((d) => d.title)).toEqual(["personal doc"]);

    // Naming the other tenant without switching is refused.
    const named = await as(joiner, "/v0/stub-docs", {
      headers: { "x-inkly-tenant": owner.tenantId },
    });
    expect(named.status).toBe(403);

    await as(joiner, "/api/me/active-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId: owner.tenantId }),
    });
    const shared = await (await as(joiner, "/v0/stub-docs")).json<{ docs: { title: string }[] }>();
    expect(shared.docs.map((d) => d.title)).toEqual(["shared doc"]);
  });

  it("refuses switching to a tenant the User is not a Member of, and logs it", async () => {
    const a = await seed();
    const b = await seed();
    const res = await as(a, "/api/me/active-tenant", {
      method: "POST",
      body: JSON.stringify({ tenantId: b.tenantId }),
    });
    expect(res.status).toBe(403);
    expect((await me(a)).activeTenant?.id).toBe(a.tenantId);
    expect(await accessLog(a.tenantId)).toEqual([
      expect.objectContaining({
        action: "write",
        status: 403,
        resource: `active-tenant ${b.tenantId}`,
      }),
    ]);
    expect(await accessLog(b.tenantId)).toEqual([]);
  });
});
