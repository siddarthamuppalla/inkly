import { z } from "zod";

// T2.4: a Document's activity, read from the access log.

export const ACTIVITY_ACTIONS = ["viewed", "downloaded", "unlocked", "denied", "edited"] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/** What an access-log entry means to someone reading a Document's activity. */
export function activityAction(entry: {
  readonly action: string;
  readonly status: number;
}): ActivityAction {
  if (entry.status !== 200) return "denied";
  switch (entry.action) {
    case "download":
      return "downloaded";
    case "unlock":
      return "unlocked";
    case "write":
      return "edited";
    default:
      return "viewed";
  }
}

export const ActivityActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.string(), name: z.string() }),
  z.object({ kind: z.literal("share-link"), shareLinkId: z.string() }),
]);
export type ActivityActor = z.infer<typeof ActivityActor>;

export const ActivityEntry = z.object({
  id: z.number().int(),
  at: z.number(),
  action: z.enum(ACTIVITY_ACTIONS),
  actor: ActivityActor,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/** One page, newest first; pass `next` as `before` for the following page. */
export const ActivityResponse = z.object({
  entries: z.array(ActivityEntry),
  next: z.number().int().nullable(),
});
export type ActivityResponse = z.infer<typeof ActivityResponse>;
