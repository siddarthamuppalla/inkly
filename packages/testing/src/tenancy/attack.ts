// verify-tenancy: as tenant A, try to reach tenant B's Documents, Versions, folders,
// content, Share links, activity, Envelopes and workspace every way we know. Every attempt must be refused (403/404) and leave an
// access-log entry.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
const PDF = readFileSync(join(FIXTURES, "tiny.pdf"));
const PDF_10P = readFileSync(join(FIXTURES, "10p.pdf"));

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

/** The status a WebSocket upgrade of `path` gets as `who`: 101 when the server accepts it. */
function upgradeStatus(baseUrl: string, who: Seeded, path: string): Promise<number> {
  const url = new URL(path, baseUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      headers: {
        authorization: `Bearer ${who.token}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
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
const DAY = 24 * 60 * 60 * 1000;

interface Link {
  link: { id: string };
  url: string;
}

interface Envelope {
  id: string;
  status: string;
}

const sha256Hex = async (bytes: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

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
  const highlight = {
    kind: "highlight",
    page: 1,
    color: "yellow",
    rects: [{ x: 0, y: 0, w: 0.5, h: 0.1 }],
  };
  const annotationOf = async (who: Seeded, doc: Doc) =>
    (
      await created<{ annotation: { id: string } }>(
        await call(baseUrl, who, "POST", `/api/documents/${doc.id}/annotations`, json(highlight)),
        "create annotation",
      )
    ).annotation.id;
  const annB = await annotationOf(b, docB);
  await annotationOf(a, docA);
  const annotationsOf = async (who: Seeded, doc: Doc) =>
    JSON.stringify(
      await (await call(baseUrl, who, "GET", `/api/documents/${doc.id}/annotations`)).json(),
    );
  const annotationsB = await annotationsOf(b, docB);
  const sharedB = await created<{ document: Doc }>(
    await call(baseUrl, b, "POST", "/api/documents?filename=b-shared.pdf", {
      headers: { "content-type": "application/pdf" },
      body: PDF_10P,
    }),
    "upload B's shared Document",
  );
  const shareOf = async (who: Seeded, documentId: string) =>
    created<Link>(
      await call(
        baseUrl,
        who,
        "POST",
        "/api/share-links",
        json({ documentId, expiresAt: Date.now() + DAY }),
      ),
      "create share link",
    );
  const linkB = await shareOf(b, sharedB.document.id);
  const linkA = await shareOf(a, docA.id);

  const envelopeOf = async (who: Seeded, doc: Doc) =>
    (
      await created<{ envelope: Envelope }>(
        await call(baseUrl, who, "POST", "/api/envelopes", json({ documentId: doc.id })),
        "create envelope",
      )
    ).envelope;
  const signerDraft = (email: string) => ({
    title: "B's lease",
    recipients: [{ id: "rcp_signer", name: "Signer", email, role: "signer" }],
    fields: [
      {
        recipientId: "rcp_signer",
        kind: "signature",
        page: 1,
        rect: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
      },
    ],
  });
  const draftB = await envelopeOf(b, docB);
  const sentB = await envelopeOf(b, docB);
  for (const id of [draftB.id, sentB.id]) {
    const res = await call(
      baseUrl,
      b,
      "PUT",
      `/api/envelopes/${id}`,
      json(signerDraft("b-signer@seed.inkly.test")),
    );
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`B's envelope PUT returned ${String(res.status)}`);
  }
  const sendB = await call(baseUrl, b, "POST", `/api/envelopes/${sentB.id}/send`);
  await sendB.arrayBuffer();
  if (sendB.status !== 200) throw new Error(`B's send returned ${String(sendB.status)}`);
  const envelopeA = await envelopeOf(a, docA);
  const envelopesOfB = async () =>
    JSON.stringify(
      await Promise.all(
        [draftB.id, sentB.id].flatMap((id) =>
          [`/api/envelopes/${id}`, `/api/envelopes/${id}/audit`].map(async (path) =>
            (await call(baseUrl, b, "GET", path)).json(),
          ),
        ),
      ),
    );
  const envelopesB = await envelopesOfB();

  // Control: A can reach its own data, so a denial below is a real denial, not a broken route.
  for (const path of [
    `/api/envelopes/${envelopeA.id}`,
    `/api/envelopes/${envelopeA.id}/audit`,
    `/api/documents/${docA.id}`,
    `/api/documents/${docA.id}/content`,
    `/api/documents/${docA.id}/versions`,
    `/api/documents/${docA.id}/versions/1/content`,
    `/api/documents/${docA.id}/form`,
    `/api/documents?folderId=${folderA}`,
    `/api/documents/${docA.id}/annotations`,
  ]) {
    const res = await call(baseUrl, a, "GET", path);
    await res.arrayBuffer();
    if (res.status !== 200) problems.push(`control: A GET ${path} returned ${String(res.status)}`);
  }
  const ownUpgrade = await upgradeStatus(baseUrl, a, `/api/documents/${docA.id}/annotations/live`);
  if (ownUpgrade !== 101) {
    problems.push(`control: A's live annotations upgrade returned ${String(ownUpgrade)}`);
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
    return res.ok
      ? (((await res.json()) as { entries?: { status: number; action: string }[] }).entries ?? [])
      : [];
  };
  // A's own writes above (its Annotation) are logged too, as edits; count only the reads.
  const controlLog = await logOf();
  if (controlLog.filter((e) => e.status === 200 && e.action !== "write").length !== 3) {
    problems.push("control: A's three content reads did not leave three access-log entries");
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
    { name: "read B's form fields", method: "GET", path: `${d}/form` },
    {
      name: "fill B's form",
      method: "POST",
      path: `${d}/form`,
      init: json({ values: {}, flatten: true }),
    },
    { name: "compress B's Document", method: "POST", path: `${d}/compress`, init: json({}) },
    {
      name: "compress B's Document claiming B's tenant",
      method: "POST",
      path: `${d}/compress`,
      init: { ...json({}), headers: { "content-type": "application/json", ...asB } },
    },
    { name: "list B's Jobs", method: "GET", path: `${d}/jobs` },
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
      name: "share B's Document",
      method: "POST",
      path: "/api/share-links",
      init: json({ documentId: sharedB.document.id, expiresAt: Date.now() + DAY }),
    },
    {
      name: "share B's Document claiming B's tenant",
      method: "POST",
      path: "/api/share-links",
      init: {
        ...json({ documentId: sharedB.document.id, expiresAt: Date.now() + DAY }),
        headers: { "content-type": "application/json", ...asB },
      },
    },
    {
      name: "list B's Document's share links",
      method: "GET",
      path: `/api/share-links?documentId=${sharedB.document.id}`,
    },
    {
      name: "list share links claiming B's tenant",
      method: "GET",
      path: "/api/share-links",
      init: { headers: asB },
    },
    {
      name: "revoke B's share link",
      method: "POST",
      path: `/api/share-links/${linkB.link.id}/revoke`,
    },
    { name: "read B's Document activity", method: "GET", path: `${d}/activity` },
    {
      name: "read B's Document activity claiming B's tenant",
      method: "GET",
      path: `${d}/activity`,
      init: { headers: asB },
    },
    {
      name: "read B's share link activity",
      method: "GET",
      path: `/api/share-links/${linkB.link.id}/activity`,
    },
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

  const ann = `${d}/annotations`;
  plan.push(
    { name: "list B's Annotations", method: "GET", path: ann },
    {
      name: "list B's Annotations claiming B's tenant",
      method: "GET",
      path: ann,
      init: { headers: asB },
    },
    { name: "annotate B's Document", method: "POST", path: ann, init: json(highlight) },
    {
      name: "recolor B's Annotation",
      method: "PATCH",
      path: `${ann}/${annB}`,
      init: json({ color: "red" }),
    },
    { name: "delete B's Annotation", method: "DELETE", path: `${ann}/${annB}` },
    {
      name: "comment on B's Annotation",
      method: "POST",
      path: `${ann}/${annB}/comments`,
      init: json({ text: "pwned" }),
    },
    { name: "resolve B's Annotation thread", method: "POST", path: `${ann}/${annB}/resolve` },
    {
      name: "download B's Document with annotations",
      method: "GET",
      path: `${d}/annotated-content`,
    },
  );

  const envelopePath = (id: string) => `/api/envelopes/${id}`;
  plan.push(
    {
      name: "list B's Envelopes claiming B's tenant",
      method: "GET",
      path: "/api/envelopes",
      init: { headers: asB },
    },
    { name: "list B's Envelopes", method: "GET", path: `/api/envelopes?tenant=${b.tenantId}` },
    {
      name: "draft an Envelope from B's Document",
      method: "POST",
      path: "/api/envelopes",
      init: json({ documentId: docB.id }),
    },
    { name: "read B's Envelope", method: "GET", path: envelopePath(sentB.id) },
    {
      name: "read B's Envelope claiming B's tenant",
      method: "GET",
      path: envelopePath(sentB.id),
      init: { headers: asB },
    },
    {
      name: "update B's draft Envelope",
      method: "PUT",
      path: envelopePath(draftB.id),
      init: json(signerDraft("intruder@seed.inkly.test")),
    },
    { name: "delete B's draft Envelope", method: "DELETE", path: envelopePath(draftB.id) },
    { name: "send B's draft Envelope", method: "POST", path: `${envelopePath(draftB.id)}/send` },
    {
      name: "void B's sent Envelope",
      method: "POST",
      path: `${envelopePath(sentB.id)}/void`,
      init: json({ reason: "pwned" }),
    },
    {
      name: "void B's sent Envelope claiming B's tenant",
      method: "POST",
      path: `${envelopePath(sentB.id)}/void`,
      init: {
        ...json({ reason: "pwned" }),
        headers: { "content-type": "application/json", ...asB },
      },
    },
    { name: "remind B's signers", method: "POST", path: `${envelopePath(sentB.id)}/remind` },
    {
      name: "read B's Envelope audit trail",
      method: "GET",
      path: `${envelopePath(sentB.id)}/audit`,
    },
    {
      name: "fetch B's Envelope content",
      method: "GET",
      path: `${envelopePath(sentB.id)}/content`,
    },
  );

  const attempts: Attempt[] = [];
  for (const live of [
    { name: "open B's live annotations WebSocket", path: `${ann}/live` },
    {
      name: "open B's live annotations WebSocket claiming B's tenant",
      path: `${ann}/live?tenant=${b.tenantId}`,
    },
  ]) {
    const status = await upgradeStatus(baseUrl, a, live.path);
    attempts.push({
      ...live,
      method: "GET (upgrade)",
      status,
      denied: status === 403 || status === 404,
    });
  }
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

  if ((await annotationsOf(b, docB)) !== annotationsB) problems.push("B's Annotations changed");
  if ((await envelopesOfB()) !== envelopesB) problems.push("B's Envelopes or audit trails changed");
  const ownEnvelopes = (await (await call(baseUrl, a, "GET", "/api/envelopes")).json()) as {
    envelopes?: Envelope[];
  };
  const ownEnvelopeIds = (ownEnvelopes.envelopes ?? []).map((e) => e.id);
  if (ownEnvelopeIds.some((id) => id === draftB.id || id === sentB.id)) {
    problems.push("A's Envelope list includes B's Envelope");
  }
  if (ownEnvelopeIds.join() !== envelopeA.id) {
    problems.push(`control: A's Envelope list is ${JSON.stringify(ownEnvelopeIds)}`);
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

  const ownLinks = (await (await call(baseUrl, a, "GET", "/api/share-links")).json()) as {
    links?: { id: string }[];
  };
  const ownLinkIds = (ownLinks.links ?? []).map((l) => l.id);
  if (ownLinkIds.includes(linkB.link.id)) problems.push("A's share links include B's link");
  if (!ownLinkIds.includes(linkA.link.id)) problems.push("control: A's link is not listed");
  const bLinks = (await (await call(baseUrl, b, "GET", "/api/share-links")).json()) as {
    links?: { id: string; revokedAt: number | null }[];
  };
  if (bLinks.links?.find((l) => l.id === linkB.link.id)?.revokedAt !== null) {
    problems.push("B's share link was revoked or lost");
  }

  // A link token opens its own Document and nothing else, whatever else the request names.
  const visit = (url: string, init: RequestInit = {}) => fetch(new URL(url, baseUrl), init);
  for (const variant of [
    { path: `/api/share/${linkA.url.slice(3)}/content`, init: {} },
    {
      path: `/api/share/${linkA.url.slice(3)}/content?documentId=${sharedB.document.id}&tenant=${b.tenantId}`,
      init: { headers: asB },
    },
  ]) {
    const res = await visit(variant.path, variant.init);
    const bytes = await res.arrayBuffer();
    if (res.status !== 200 || (await sha256Hex(bytes)) !== docA.sha256) {
      problems.push(`A's link served something other than A's Document at ${variant.path}`);
    }
  }
  const viaB = await visit(`/api/share/${linkB.url.slice(3)}/content`);
  if ((await sha256Hex(await viaB.arrayBuffer())) !== sharedB.document.sha256) {
    problems.push("control: B's link did not serve B's shared Document");
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
