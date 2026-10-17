import { z } from "zod";

// Jobs: async work the API enqueues and workers/jobs runs (GLOSSARY "Job").

/** Ghostscript's `-dPDFSETTINGS` presets that pdf-engine accepts: smallest to best quality. */
export const COMPRESS_LEVELS = ["screen", "ebook", "printer"] as const;
export const CompressLevel = z.enum(COMPRESS_LEVELS);
export type CompressLevel = z.infer<typeof CompressLevel>;

export const CompressRequest = z.object({ level: CompressLevel.default("ebook") });
export type CompressRequest = z.infer<typeof CompressRequest>;

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** What a compress Job did: the Version it added, or none when the PDF was already as small as it gets. */
export const CompressOutput = z.object({
  version: z.number().int().nullable(),
  bytesBefore: z.number().int(),
  bytesAfter: z.number().int(),
});
export type CompressOutput = z.infer<typeof CompressOutput>;

export const JobInfo = z.object({
  id: z.string(),
  kind: z.literal("compress"),
  documentId: z.string(),
  status: z.enum(JOB_STATUSES),
  level: CompressLevel,
  fromVersion: z.number().int(),
  output: CompressOutput.nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type JobInfo = z.infer<typeof JobInfo>;

export const JobResponse = z.object({ job: JobInfo });
export const JobListResponse = z.object({ jobs: z.array(JobInfo) });
