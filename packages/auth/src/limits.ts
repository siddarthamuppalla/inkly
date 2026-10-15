// Q8: Members per Plan, owner included. Unknown plans get the Free Limit.
const MEMBER_LIMIT = { free: 1, pro: 5 } as const;

export function memberLimit(plan: string | undefined): number {
  return plan === "pro" ? MEMBER_LIMIT.pro : MEMBER_LIMIT.free;
}
