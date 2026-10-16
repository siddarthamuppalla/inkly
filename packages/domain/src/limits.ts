import { AppError } from "./errors.ts";

export const MiB = 1024 * 1024;

export type Plan = "free" | "pro";

export interface PlanLimits {
  readonly fileBytes: number;
  readonly storageBytes: number;
}

/** Q8 limits. Sizes are binary (MiB), so a file the OS calls "25 MB" always fits. */
export const PLAN_LIMITS: Readonly<Record<Plan, PlanLimits>> = {
  free: { fileBytes: 25 * MiB, storageBytes: 500 * MiB },
  pro: { fileBytes: 100 * MiB, storageBytes: 20 * 1024 * MiB },
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
