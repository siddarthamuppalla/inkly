import { AppError } from "./errors.ts";

export const MiB = 1024 * 1024;

export type Plan = "free" | "pro";

export interface PlanLimits {
  readonly fileBytes: number;
  readonly storageBytes: number;
  /** Page ops (rotate, reorder, delete pages, merge, split) per billing period. */
  readonly pageOps: number;
  /** Envelopes sent per billing period; drafts are free (ADR-0006). */
  readonly envelopes: number;
}

/** Q8 limits. Sizes are binary (MiB), so a file the OS calls "25 MB" always fits. Pro ops are "unlimited" under a 2,000/month fair-use cap. */
export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { fileBytes: 25 * MiB, storageBytes: 500 * MiB, pageOps: 50, envelopes: 3 },
  pro: { fileBytes: 100 * MiB, storageBytes: 20 * 1024 * MiB, pageOps: 2000, envelopes: 50 },
};

function mib(bytes: number): string {
  return `${String(Math.round(bytes / MiB))} MB`;
}

/** Refuses a file over the Plan's per-file limit with 413. */
export function assertFileSizeAllowed(plan: Plan, fileBytes: number): void {
  const { fileBytes: max } = PLAN_LIMITS[plan];
  if (fileBytes > max) {
    throw new AppError("limit_exceeded", `Files on the ${plan} plan can be up to ${mib(max)}`, 413);
  }
}

/** Refuses a new Version that is too big, or that would take storage Usage over the Limit (402). */
export function assertUploadAllowed(
  plan: Plan,
  usage: { readonly fileBytes: number; readonly storageBytes: number },
): void {
  assertFileSizeAllowed(plan, usage.fileBytes);
  const { storageBytes: max } = PLAN_LIMITS[plan];
  if (usage.storageBytes + usage.fileBytes > max) {
    throw new AppError("limit_exceeded", `The ${plan} plan includes ${mib(max)} of storage`);
  }
}

/** Q8: the longest a Free share link may stay open. */
export const FREE_SHARE_LINK_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Q8 share-link rules. Free links expire within 7 days, have no password and always allow
 * download; Pro links may have any expiry or none, a password and download off (402).
 */
export function assertShareLinkAllowed(
  plan: Plan,
  link: {
    readonly expiresAt: number | null;
    readonly password: string | null;
    readonly allowDownload: boolean;
  },
  now: number,
): void {
  if (link.expiresAt !== null && link.expiresAt <= now) {
    throw new AppError("invalid_input", "The expiry date must be in the future");
  }
  if (plan === "pro") return;
  if (link.expiresAt === null || link.expiresAt - now > FREE_SHARE_LINK_MAX_MS) {
    throw new AppError("limit_exceeded", "Share links on the free plan expire within 7 days");
  }
  if (link.password !== null) {
    throw new AppError("limit_exceeded", "Password-protected links need the Pro plan");
  }
  if (!link.allowDownload) {
    throw new AppError("limit_exceeded", "Turning off download needs the Pro plan");
  }
}

/** The `limit_exceeded` (402) a page op gets once the period's page ops are used up. */
export function pageOpLimitError(plan: Plan): AppError {
  const max = PLAN_LIMITS[plan].pageOps;
  return new AppError(
    "limit_exceeded",
    `The ${plan} plan includes ${String(max)} page edits a month; this month's are used up`,
  );
}

/** The `limit_exceeded` (402) a send gets once the period's Envelopes are used up. */
export function envelopeLimitError(plan: Plan): AppError {
  const max = PLAN_LIMITS[plan].envelopes;
  return new AppError(
    "limit_exceeded",
    `The ${plan} plan includes ${String(max)} envelopes a month; this month's are used up`,
  );
}
