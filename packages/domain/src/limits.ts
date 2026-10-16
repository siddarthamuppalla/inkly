import { AppError } from "./errors.ts";

export const MiB = 1024 * 1024;

export type Plan = "free" | "pro";

export interface PlanLimits {
  readonly fileBytes: number;
  readonly storageBytes: number;
  /** Page ops (rotate, reorder, delete pages, merge, split) per billing period. */
  readonly pageOps: number;
}

/** Q8 limits. Sizes are binary (MiB), so a file the OS calls "25 MB" always fits. Pro ops are "unlimited" under a 2,000/month fair-use cap. */
export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { fileBytes: 25 * MiB, storageBytes: 500 * MiB, pageOps: 50 },
  pro: { fileBytes: 100 * MiB, storageBytes: 20 * 1024 * MiB, pageOps: 2000 },
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

/** The `limit_exceeded` (402) a page op gets once the period's page ops are used up. */
export function pageOpLimitError(plan: Plan): AppError {
  const max = PLAN_LIMITS[plan].pageOps;
  return new AppError(
    "limit_exceeded",
    `The ${plan} plan includes ${String(max)} page edits a month; this month's are used up`,
  );
}
