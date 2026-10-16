// verify-tenancy: as tenant A, try to reach tenant B's Documents, Versions, folders,
// content and workspace every way we know. Every attempt must be refused (403/404) and leave an
// access-log entry.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

interface Doc {
  id: string;
  title: string;
  folderId: string | null;
  currentVersion: number;
  sha256: string;
  deletedAt: number | null;
}

const PDF = readFileSync(join(import.meta.dirname, "../../../../fixtures/pdfs/tiny.pdf"));

/** Body and content type of an unexpected response, so a failure says who answered. */
async function describe(res: Response): Promise<string> {
  const body = (await res.text()).slice(0, 200);
  return `${res.headers.get("content-type") ?? "no content-type"} ${JSON.stringify(body)}`;
}

async function seed(baseUrl: string, secret: string): Promise<Seeded> {
  const res = await fetch(new URL("/__test/seed", baseUrl), {
    method: "POST",
    headers: { "x-test-hooks-secret": secret },
  });
  if (res.status !== 201) {
    throw new Error(`seed returned ${String(res.status)}, expected 201: ${await describe(res)}`);
  }
  return (await res.json()) as Seeded;
}

function call(baseUrl: string, who: Seeded, method: string, path: string, extra: RequestInit = {}) {
  const headers = new Headers(extra.headers);
  headers.set("authorization", `Bearer ${who.token}`);
  return fetch(new URL(path, baseUrl), { ...extra, method, headers });
}

async function created<T>(res: Response, what: string): Promise<T> {
  if (res.status !== 201) {
    throw new Error(`${what} returned ${String(res.status)}: ${await describe(res)}`);
  }
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const pdf: RequestInit = { headers: { "content-type": "application/pdf" }, body: PDF };

export async function attackTenancy(baseUrl: string, secret: string): Promise<TenancyReport> {
  const problems: string[] = [];
  const a = await seed(baseUrl, secret);
  const b = await seed(baseUrl, secret);

  const folderOf = async (who: Seeded, name: string) =>
    (
      await created<{ folder: { id: string } }>(
        await call(baseUrl, who, "POST", "/api/folders", json({ name })),
        "create folder",
      )
    ).folder.id;
  const upload = async (who: Seeded, folderId: string) =>
    (
      await created<{ document: Doc }>(
        await call(baseUrl, who, "POST", `/api/documents?filename=x.pdf&folderId=${folderId}`, pdf),
        "upload",
      )
    ).document;

  const folderB = await folderOf(b, "B folder");
  const docB = await upload(b, folderB);
  const trashedB = await upload(b, folderB);
  await call(baseUrl, b, "DELETE", `/api/documents/${trashedB.id}`);
  const folderA = await folderOf(a, "A folder");
  const docA = await upload(a, folderA);

  // Control: A can reach its own data, so a denial below is a real denial, not a broken route.
  for (const path of [
    `/api/documents/${docA.id}`,
    `/api/documents/${docA.id}/content`,
    `/api/documents/${docA.id}/versions`,
    `/api/documents/${docA.id}/versions/1/content`,
    `/api/documents?folderId=${folderA}`,
  ]) {
    const res = await call(baseUrl, a, "GET", path);
    await res.arrayBuffer();
    if (res.status !== 200) problems.push(`control: A GET ${path} returned ${String(res.status)}`);
  }
  const ownList = (await (
    await call(baseUrl, a, "GET", `/api/documents?folderId=${folderA}`)
  ).json()) as { documents?: { id: string }[] };
  const listedIds = (ownList.documents ?? []).map((d) => d.id);
  if (!listedIds.includes(docA.id)) problems.push("control: A's list is missing A's Document");
  if (listedIds.includes(docB.id)) problems.push("A's own list includes B's Document");
  const ownFolders = (await (await call(baseUrl, a, "GET", "/api/folders")).json()) as {
    folders?: { id: string }[];
  };
  if ((ownFolders.folders ?? []).some((f) => f.id === folderB)) {
    problems.push("A's folder list includes B's folder");
  }
  const logOf = async () => {
    const res = await fetch(new URL(`/__test/access-log?tenant=${a.tenantId}`, baseUrl), {
      headers: { "x-test-hooks-secret": secret },
    });
    return res.ok ? (((await res.json()) as { entries?: { status: number }[] }).entries ?? []) : [];
  };
  const controlLog = await logOf();
  if (controlLog.filter((e) => e.status === 200).length !== 2) {
    problems.push("control: A's two content reads did not leave two access-log entries");
  }

  /** Documents `who` has at the top level plus in `folder`: where a merge or split would land. */
  const countDocs = async (who: Seeded, folder: string) => {
    let n = 0;
    for (const q of ["", `?folderId=${folder}`]) {
      const res = await call(baseUrl, who, "GET", `/api/documents${q}`);
      n += ((await res.json()) as { documents?: unknown[] }).documents?.length ?? 0;
    }
    return n;
  };
  const docsBefore = { a: await countDocs(a, folderA), b: await countDocs(b, folderB) };
  const asB = { "x-inkly-tenant": b.tenantId };
  const d = `/api/documents/${docB.id}`;
  const plan: { name: string; method: string; path: string; init?: RequestInit }[] = [
    { name: "read B's Document", method: "GET", path: d },
    {
      name: "read B's Document claiming B's tenant",
      method: "GET",
      path: d,
      init: { headers: asB },
    },
    { name: "rename B's Document", method: "PATCH", path: d, init: json({ title: "pwned by A" }) },
    {
      name: "rename B's Document claiming B's tenant",
      method: "PATCH",
      path: d,
      init: {
        ...json({ title: "pwned by A" }),
        headers: { "content-type": "application/json", ...asB },
      },
    },
    {
      name: "move B's Document into A's folder",
      method: "PATCH",
      path: d,
      init: json({ folderId: folderA }),
    },
    {
      name: "move A's Document into B's folder",
      method: "PATCH",
      path: `/api/documents/${docA.id}`,
      init: json({ folderId: folderB }),
    },
    { name: "trash B's Document", method: "DELETE", path: d },
    {
      name: "restore B's Document from Trash",
      method: "POST",
      path: `/api/documents/${trashedB.id}/restore`,
    },
    { name: "list B's Documents", method: "GET", path: `/api/documents?tenant=${b.tenantId}` },
    {
      name: "list claiming B's tenant",
      method: "GET",
      path: "/api/documents",
      init: { headers: asB },
    },
    { name: "list B's folder", method: "GET", path: `/api/documents?folderId=${folderB}` },
    {
      name: "list B's folders claiming B's tenant",
      method: "GET",
      path: "/api/folders",
      init: { headers: asB },
    },
    { name: "fetch B's content", method: "GET", path: `${d}/content` },
    {
      name: "fetch B's content claiming B's tenant",
      method: "GET",
      path: `${d}/content`,
      init: { headers: asB },
    },
    { name: "list B's Versions", method: "GET", path: `${d}/versions` },
    { name: "fetch B's Version 1 content", method: "GET", path: `${d}/versions/1/content` },
    { name: "add a Version to B's Document", method: "POST", path: `${d}/versions`, init: pdf },
    { name: "restore B's Version 1", method: "POST", path: `${d}/versions/1/restore` },
    {
      name: "rotate B's pages",
      method: "POST",
      path: `${d}/rotate`,
      init: json({ pages: [1], degrees: 90 }),
    },
    { name: "reorder B's pages", method: "POST", path: `${d}/reorder`, init: json({ order: [1] }) },
    {
      name: "delete B's pages",
      method: "POST",
      path: `${d}/delete-pages`,
      init: json({ pages: [1] }),
    },
    {
      name: "split B's Document",
      method: "POST",
      path: `${d}/split`,
      init: json({ ranges: [{ from: 1, to: 1 }] }),
    },
    {
      name: "merge B's Document into A's",
      method: "POST",
      path: "/api/documents/merge",
      init: json({ documentIds: [docA.id, docB.id] }),
    },
    {
      name: "merge claiming B's tenant",
      method: "POST",
      path: "/api/documents/merge",
      init: {
        ...json({ documentIds: [docB.id, docB.id] }),
        headers: { "content-type": "application/json", ...asB },
      },
    },
    {
      name: "upload into B's folder",
      method: "POST",
      path: `/api/documents?folderId=${folderB}`,
      init: pdf,
    },
    {
      name: "rename B's folder",
      method: "PATCH",
      path: `/api/folders/${folderB}`,
      init: json({ name: "pwned" }),
    },
    {
      name: "nest a folder in B's folder",
      method: "POST",
      path: "/api/folders",
      init: json({ name: "x", parentId: folderB }),
    },
    {
      name: "move A's folder into B's folder",
      method: "PATCH",
      path: `/api/folders/${folderA}`,
      init: json({ parentId: folderB }),
    },
    { name: "delete B's folder", method: "DELETE", path: `/api/folders/${folderB}` },
    {
      name: "switch Active tenant to B",
      method: "POST",
      path: "/api/me/active-tenant",
      init: json({ tenantId: b.tenantId }),
    },
    {
      name: "list B's members claiming B's tenant",
      method: "GET",
      path: "/api/tenant/members",
      init: { headers: asB },
    },
    {
      name: "invite into B claiming B's tenant",
      method: "POST",
      path: "/api/tenant/invitations",
      init: {
        ...json({ email: "intruder@seed.inkly.test", role: "admin" }),
        headers: { "content-type": "application/json", ...asB },
      },
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

  const docNow = async (id: string) => {
    const res = await call(baseUrl, b, "GET", `/api/documents/${id}`);
    return res.status === 200 ? ((await res.json()) as { document: Doc }).document : null;
  };
  const docBNow = await docNow(docB.id);
  if (JSON.stringify(docBNow) !== JSON.stringify(docB)) {
    problems.push(`B's Document changed: ${JSON.stringify(docBNow)}`);
  }
  if ((await docNow(trashedB.id))?.deletedAt === null)
    problems.push("B's trashed Document was restored");
  const bFolders = (await (await call(baseUrl, b, "GET", "/api/folders")).json()) as {
    folders?: { id: string; name: string; parentId: string | null }[];
  };
  const folderBNow = (bFolders.folders ?? []).find((f) => f.id === folderB);
  if (bFolders.folders?.length !== 1 || folderBNow?.name !== "B folder") {
    problems.push(`B's folders changed: ${JSON.stringify(bFolders.folders)}`);
  }
  const docANow = (await (await call(baseUrl, a, "GET", `/api/documents/${docA.id}`)).json()) as {
    document?: Doc;
  };
  if (docANow.document?.folderId !== folderA) problems.push("A's Document left A's folder");

  const me = (await (await call(baseUrl, a, "GET", "/api/me")).json()) as {
    activeTenant?: { id?: string } | null;
  };
  if (me.activeTenant?.id !== a.tenantId) {
    problems.push(`A's Active tenant is ${String(me.activeTenant?.id)} after the switch attempt`);
  }
  const listAfter = (await (await call(baseUrl, a, "GET", "/api/documents")).json()) as {
    documents?: { id: string }[];
  };
  if ((listAfter.documents ?? []).some((d) => d.id === docB.id)) {
    problems.push("A's list includes B's Document after the switch attempt");
  }

  const docsAfter = { a: await countDocs(a, folderA), b: await countDocs(b, folderB) };
  if (docsAfter.a !== docsBefore.a || docsAfter.b !== docsBefore.b) {
    problems.push(
      `Document counts changed (A ${String(docsBefore.a)}→${String(docsAfter.a)}, B ${String(docsBefore.b)}→${String(docsAfter.b)})`,
    );
  }

  const deniedEntries = (await logOf()).filter((e) => e.status === 403 || e.status === 404).length;
  const deniedCount = attempts.filter((t) => t.denied).length;
  if (deniedEntries !== deniedCount) {
    problems.push(
      `access log has ${String(deniedEntries)} denial entries for ${String(deniedCount)} denied attempts`,
    );
  }
  for (const t of attempts) {
    if (!t.denied) problems.push(`${t.name}: ${t.method} ${t.path} returned ${String(t.status)}`);
  }
  return { ok: problems.length === 0, attempts, problems, accessLogEntries: deniedEntries };
}
