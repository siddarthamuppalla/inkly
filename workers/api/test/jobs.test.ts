import type { Role } from "@inkly/auth";
import type { JobId, JobInfo, TenantId, UserId } from "@inkly/domain";
import {
  consumeJobs,
  EngineRefusal,
  runJob,
  type Compressed,
  type Engine,
  type JobMessage,
} from "@inkly/jobs";
import { addVersion, beginJobCommit, getJob, listVersions, startJobAttempt } from "@inkly/storage";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { onAppError } from "../src/errors.ts";
import type { Env } from "../src/index.ts";
import { jobRoutes } from "../src/jobs.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { accessLog, as, fixture, hooks, json, seed, sha256, uploaded } from "./helpers.ts";

// The consumer runs with a fake pdf-engine (T1.4b); the Queue producer is captured.

interface Fixture {
  bindings: Env;
  sent: JobMessage[];
}

function withQueue(): Fixture {
  const sent: JobMessage[] = [];
  const JOBS = {
    send: (body: JobMessage) => {
      sent.push(body);
      return Promise.resolve();
    },
  } as unknown as Queue<JobMessage>;
  return { bindings: { ...hooks, JOBS }, sent };
}

/** An engine that "compresses" anything into tiny.pdf, counting its calls. */
function fakeEngine(
  result: () => Promise<Compressed> | Compressed = () => ({
    body: fixture("tiny.pdf"),
    compressed: true,
  }),
): Engine & { calls: number } {
  const engine = {
    calls: 0,
    async compress(pdf: ReadableStream | Uint8Array) {
      engine.calls++;
      if (pdf instanceof ReadableStream) await new Response(pdf).arrayBuffer();
      return result();
    },
  };
  return engine;
}

interface Delivery {
  acked: boolean;
  retried: boolean;
}

async function deliver(body: JobMessage, engine: Engine, attempts = 1): Promise<Delivery> {
  const delivery = { acked: false, retried: false };
  const message = {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: () => {
      delivery.acked = true;
    },
    retry: () => {
      delivery.retried = true;
    },
  };
  const batch = {
    queue: "inkly-jobs",
    messages: [message],
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<JobMessage>;
  await consumeJobs(batch, hooks, engine);
  return delivery;
}

async function compress(
  who: { token: string },
  documentId: string,
  q: Fixture,
  init: { level?: string; key?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.key !== undefined) headers["idempotency-key"] = init.key;
  return as(
    who,
    `/api/documents/${documentId}/compress`,
    { method: "POST", headers, body: JSON.stringify(init.level ? { level: init.level } : {}) },
    q.bindings,
  );
}

async function jobOf(who: { token: string }, id: string): Promise<JobInfo> {
  const res = await as(who, `/api/jobs/${id}`);
  expect(res.status).toBe(200);
  return (await res.json<{ job: JobInfo }>()).job;
}

async function started(who: { token: string; tenantId: TenantId }, name = "10p.pdf") {
  const doc = await uploaded(who, name);
  const q = withQueue();
  const res = await compress(who, doc.id, q);
  expect(res.status).toBe(202);
  const { job } = await res.json<{ job: JobInfo }>();
  return { doc, q, job, message: q.sent[0] as JobMessage };
}

describe("POST /api/documents/:id/compress", () => {
  it("creates a queued Job and sends one Queue message", async () => {
    const owner = await seed();
    const { doc, q, job } = await started(owner);
    expect(job).toMatchObject({
      kind: "compress",
      documentId: doc.id,
      status: "queued",
      level: "ebook",
      fromVersion: 1,
      output: null,
      error: null,
    });
    expect(q.sent).toEqual([{ tenantId: owner.tenantId, jobId: job.id }]);
  });

  it("returns the same Job for the same Version and level, and sends nothing more", async () => {
    const owner = await seed();
    const { doc, q, job } = await started(owner);
    const again = await compress(owner, doc.id, q);
    expect(again.status).toBe(200);
    expect((await again.json<{ job: JobInfo }>()).job.id).toBe(job.id);
    const otherLevel = await compress(owner, doc.id, q, { level: "screen" });
    expect(otherLevel.status).toBe(202);
    expect((await otherLevel.json<{ job: JobInfo }>()).job.id).not.toBe(job.id);
    expect(q.sent).toHaveLength(2);
  });

  it("honors a client Idempotency-Key", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const q = withQueue();
    const a = await compress(owner, doc.id, q, { key: "click-1", level: "screen" });
    const b = await compress(owner, doc.id, q, { key: "click-1", level: "printer" });
    expect([a.status, b.status]).toEqual([202, 200]);
    const [ja, jb] = [await a.json<{ job: JobInfo }>(), await b.json<{ job: JobInfo }>()];
    expect(jb.job).toMatchObject({ id: ja.job.id, level: "screen" });
    expect((await compress(owner, doc.id, q, { key: "bad key" })).status).toBe(422);
  });

  it("refuses an unknown level", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    expect((await compress(owner, doc.id, withQueue(), { level: "tiny" })).status).toBe(422);
  });

  it("re-queues a failed Job when asked again", async () => {
    const owner = await seed();
    const { doc, q, job, message } = await started(owner);
    await deliver(
      message,
      fakeEngine(() => {
        throw new EngineRefusal("pdf_malformed");
      }),
    );
    expect((await jobOf(owner, job.id)).status).toBe("failed");
    const retry = await compress(owner, doc.id, q);
    expect(retry.status).toBe(202);
    expect((await retry.json<{ job: JobInfo }>()).job).toMatchObject({
      id: job.id,
      status: "queued",
      error: null,
    });
    expect(q.sent).toHaveLength(2);
  });

  it("is 404 (logged) for another Tenant's Document or Job", async () => {
    const a = await seed();
    const b = await seed();
    const { doc, job } = await started(b);
    expect((await compress(a, doc.id, withQueue())).status).toBe(404);
    expect((await as(a, `/api/jobs/${job.id}`)).status).toBe(404);
    expect((await as(a, `/api/documents/${doc.id}/jobs`)).status).toBe(404);
    expect((await accessLog(a.tenantId)).map((e) => [e.action, e.status])).toEqual([
      ["write", 404],
      ["read", 404],
      ["list", 404],
    ]);
  });

  it("is 403 for a viewer, who can still read Jobs", async () => {
    const owner = await seed();
    const { doc, job } = await started(owner);
    const viewer = appAs(owner, "viewer", withQueue().bindings);
    expect((await viewer(`/api/documents/${doc.id}/compress`, json("POST", {}))).status).toBe(403);
    expect((await viewer(`/api/jobs/${job.id}`)).status).toBe(200);
    expect((await viewer(`/api/documents/${doc.id}/jobs`)).status).toBe(200);
  });
});

function appAs(who: { tenantId: TenantId; userId: string }, role: Role, bindings: Env) {
  const session = { tenantId: who.tenantId, userId: who.userId as UserId, role };
  const app = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  app.onError(onAppError);
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  app.route("/api", jobRoutes);
  return (path: string, init: RequestInit = {}) => app.request(path, init, bindings);
}

describe("the jobs consumer", () => {
  it("compresses through the engine and adds a new Version", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const engine = fakeEngine();
    expect(await deliver(message, engine)).toEqual({ acked: true, retried: false });

    expect(engine.calls).toBe(1);
    const done = await jobOf(owner, job.id);
    expect(done).toMatchObject({
      status: "succeeded",
      error: null,
      output: {
        version: 2,
        bytesBefore: fixture("10p.pdf").byteLength,
        bytesAfter: fixture("tiny.pdf").byteLength,
      },
    });
    const res = await as(owner, `/api/documents/${doc.id}`);
    expect(
      (await res.json<{ document: { currentVersion: number } }>()).document.currentVersion,
    ).toBe(2);
    const content = await as(owner, `/api/documents/${doc.id}/content`);
    expect(await sha256(await content.arrayBuffer())).toBe(await sha256(fixture("tiny.pdf")));
    const listed = await as(owner, `/api/documents/${doc.id}/jobs`);
    expect((await listed.json<{ jobs: JobInfo[] }>()).jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it("never adds a second Version when the same message is delivered again", async () => {
    const owner = await seed();
    const { doc, message } = await started(owner);
    const engine = fakeEngine();
    await deliver(message, engine);
    expect(await deliver(message, engine)).toEqual({ acked: true, retried: false });
    expect(engine.calls).toBe(1);
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).map((v) => v.n)).toEqual([
      2, 1,
    ]);
  });

  it("adds one Version when two deliveries of the message run at once", async () => {
    const owner = await seed();
    const { doc, message } = await started(owner);
    const engine = fakeEngine();
    await Promise.all([
      runJob(hooks, message, engine, false),
      runJob(hooks, message, engine, false),
    ]);
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).map((v) => v.n)).toEqual([
      2, 1,
    ]);
  });

  it("finishes a Job whose Version landed before the delivery crashed, without adding another", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const tiny = fixture("tiny.pdf");
    const sha = await sha256(tiny);
    const id = job.id as JobId;
    // The crashed delivery: claimed, committed and added the Version, then died.
    const attempt = await startJobAttempt(owner.tenantId, hooks, id);
    expect(await beginJobCommit(owner.tenantId, hooks, id, attempt ?? 0, sha)).toBe(true);
    await addVersion(owner.tenantId, hooks, doc.id as never, {
      body: tiny,
      sha256: sha,
      pages: 10,
      createdBy: owner.userId as UserId,
    });

    const engine = fakeEngine();
    await deliver(message, engine);
    expect(engine.calls).toBe(0);
    expect(await jobOf(owner, job.id)).toMatchObject({
      status: "succeeded",
      output: { version: 2 },
    });
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).length).toBe(2);
  });

  it("runs a Job again when its commit never reached D1", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const id = job.id as JobId;
    const attempt = await startJobAttempt(owner.tenantId, hooks, id);
    await beginJobCommit(owner.tenantId, hooks, id, attempt ?? 0, "0".repeat(64));

    const engine = fakeEngine();
    await deliver(message, engine);
    expect(engine.calls).toBe(1);
    expect(await jobOf(owner, job.id)).toMatchObject({
      status: "succeeded",
      output: { version: 2 },
    });
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).length).toBe(2);
  });

  it("fails the Job and leaves the Document unchanged when the engine refuses the PDF", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const engine = fakeEngine(() => {
      throw new EngineRefusal("pdf_encrypted");
    });
    expect(await deliver(message, engine)).toEqual({ acked: true, retried: false });
    expect(await jobOf(owner, job.id)).toMatchObject({
      status: "failed",
      output: null,
      error: "This PDF is password-protected, so it can't be compressed.",
    });
    const versions = await listVersions(owner.tenantId, hooks, doc.id as never);
    expect(versions.map((v) => v.sha256)).toEqual([await sha256(fixture("10p.pdf"))]);
  });

  it("retries an unavailable engine, then fails the Job on the last delivery", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const engine = fakeEngine(() => {
      throw new Error("container did not start");
    });
    expect(await deliver(message, engine, 1)).toEqual({ acked: false, retried: true });
    expect((await jobOf(owner, job.id)).status).toBe("running");
    expect(await deliver(message, engine, 3)).toEqual({ acked: true, retried: false });
    expect(await jobOf(owner, job.id)).toMatchObject({
      status: "failed",
      error: "Compression didn't finish. Try again in a few minutes.",
    });
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).length).toBe(1);
  });

  it("succeeds without a new Version when the PDF is already as small as it gets", async () => {
    const owner = await seed();
    const { doc, job, message } = await started(owner);
    const engine = fakeEngine(() => ({ body: fixture("10p.pdf"), compressed: false }));
    await deliver(message, engine);
    const bytes = fixture("10p.pdf").byteLength;
    expect(await jobOf(owner, job.id)).toMatchObject({
      status: "succeeded",
      output: { version: null, bytesBefore: bytes, bytesAfter: bytes },
    });
    expect((await listVersions(owner.tenantId, hooks, doc.id as never)).length).toBe(1);
  });

  it("acks a message naming no Job", async () => {
    const owner = await seed();
    const engine = fakeEngine();
    const missing = { tenantId: owner.tenantId, jobId: "job_missing" };
    expect(await deliver(missing, engine)).toEqual({ acked: true, retried: false });
    expect(await deliver({ tenantId: "../x", jobId: "j" }, engine)).toEqual({
      acked: true,
      retried: false,
    });
    expect(await getJob(owner.tenantId, hooks, "job_missing" as JobId)).toBeNull();
    expect(engine.calls).toBe(0);
  });
});
