// verify-tenancy: as tenant A, try to reach tenant B's stub doc every way we know.
// Every attempt must be refused (403/404) and leave an access-log entry.

export interface Attempt {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly denied: boolean;
}

export interface TenancyReport {
  readonly ok: boolean;
  readonly attempts: readonly Attempt[];
  readonly problems: readonly string[];
  readonly accessLogEntries: number;
}

interface Seeded {
  tenantId: string;
  userId: string;
  token: string;
}

async function seed(baseUrl: string, secret: string): Promise<Seeded> {
  const res = await fetch(new URL("/__test/seed", baseUrl), {
    method: "POST",
    headers: { "x-test-hooks-secret": secret },
  });
  if (res.status !== 201) throw new Error(`seed returned ${String(res.status)}, expected 201`);
  return (await res.json()) as Seeded;
}

function call(baseUrl: string, who: Seeded, method: string, path: string, extra: RequestInit = {}) {
  const headers = new Headers(extra.headers);
  headers.set("authorization", `Bearer ${who.token}`);
  return fetch(new URL(path, baseUrl), { ...extra, method, headers });
}

export async function attackTenancy(baseUrl: string, secret: string): Promise<TenancyReport> {
  const problems: string[] = [];
  const a = await seed(baseUrl, secret);
  const b = await seed(baseUrl, secret);

  const create = async (who: Seeded, title: string) => {
    const res = await call(baseUrl, who, "POST", "/v0/stub-docs", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, content: `secret of ${who.tenantId}` }),
    });
    if (res.status !== 201) throw new Error(`create doc returned ${String(res.status)}`);
    return ((await res.json()) as { id: string }).id;
  };
  const docB = await create(b, "B original");
  const docA = await create(a, "A original");

  // Control: A can reach its own doc, so a denial below is a real denial, not a broken route.
  for (const path of [`/v0/stub-docs/${docA}`, `/v0/stub-docs/${docA}/content`]) {
    const res = await call(baseUrl, a, "GET", path);
    if (res.status !== 200) problems.push(`control: A GET ${path} returned ${String(res.status)}`);
  }
  const ownList = (await (await call(baseUrl, a, "GET", "/v0/stub-docs")).json()) as {
    docs?: { id: string }[];
  };
  const listedIds = (ownList.docs ?? []).map((d) => d.id);
  if (!listedIds.includes(docA)) problems.push("control: A's list is missing A's doc");
  if (listedIds.includes(docB)) problems.push("A's own list includes B's doc");

  const asB = { "x-inkly-tenant": b.tenantId };
  const json = { "content-type": "application/json" };
  const put = JSON.stringify({ title: "pwned by A" });
  const plan: { name: string; method: string; path: string; init?: RequestInit }[] = [
    { name: "read B's doc", method: "GET", path: `/v0/stub-docs/${docB}` },
    {
      name: "read B's doc claiming B's tenant",
      method: "GET",
      path: `/v0/stub-docs/${docB}`,
      init: { headers: asB },
    },
    {
      name: "write B's doc",
      method: "PUT",
      path: `/v0/stub-docs/${docB}`,
      init: { headers: json, body: put },
    },
    {
      name: "write B's doc claiming B's tenant",
      method: "PUT",
      path: `/v0/stub-docs/${docB}`,
      init: { headers: { ...json, ...asB }, body: put },
    },
    { name: "list B's docs", method: "GET", path: `/v0/stub-docs?tenant=${b.tenantId}` },
    {
      name: "list claiming B's tenant",
      method: "GET",
      path: "/v0/stub-docs",
      init: { headers: asB },
    },
    { name: "fetch B's R2 object", method: "GET", path: `/v0/stub-docs/${docB}/content` },
    {
      name: "fetch B's R2 object claiming B's tenant",
      method: "GET",
      path: `/v0/stub-docs/${docB}/content`,
      init: { headers: asB },
    },
  ];

  const attempts: Attempt[] = [];
  for (const p of plan) {
    const res = await call(baseUrl, a, p.method, p.path, p.init);
    await res.arrayBuffer();
    attempts.push({
      name: p.name,
      method: p.method,
      path: p.path,
      status: res.status,
      denied: res.status === 403 || res.status === 404,
    });
  }

  const after = await call(baseUrl, b, "GET", `/v0/stub-docs/${docB}`);
  const title = after.status === 200 ? ((await after.json()) as { title?: string }).title : "?";
  if (title !== "B original") problems.push(`B's doc title changed to ${String(title)}`);

  const logRes = await fetch(new URL(`/__test/access-log?tenant=${a.tenantId}`, baseUrl), {
    headers: { "x-test-hooks-secret": secret },
  });
  const entries = logRes.ok
    ? (((await logRes.json()) as { entries?: unknown[] }).entries?.length ?? 0)
    : 0;
  const deniedCount = attempts.filter((t) => t.denied).length;
  if (entries !== deniedCount) {
    problems.push(
      `access log has ${String(entries)} entries for ${String(deniedCount)} denied attempts`,
    );
  }
  for (const t of attempts) {
    if (!t.denied) problems.push(`${t.name}: ${t.method} ${t.path} returned ${String(t.status)}`);
  }
  return { ok: problems.length === 0, attempts, problems, accessLogEntries: entries };
}
