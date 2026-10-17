import type { ActivityAction, ActivityEntry } from "@inkly/domain";
import { useInfiniteQuery } from "@tanstack/react-query";

import { errorMessage } from "../lib/api.ts";
import { activityApi } from "../lib/activity-api.ts";
import { formatDateTime } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";

const VERB: Record<ActivityAction, string> = {
  viewed: "viewed",
  downloaded: "downloaded",
  unlocked: "unlocked",
  denied: "was refused",
  edited: "edited",
};

function actorName(entry: ActivityEntry): string {
  return entry.actor.kind === "member" ? entry.actor.name : "Someone with a share link";
}

/** A Document's (or one Share link's) activity, newest first, a page at a time. */
export function ActivityList({
  of,
  id,
  label,
}: {
  readonly of: "document" | "shareLink";
  readonly id: string;
  readonly label: string;
}) {
  const activity = useInfiniteQuery({
    queryKey: ["activity", of, id],
    queryFn: ({ pageParam }) => activityApi[of](id, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next,
  });
  const entries = activity.data?.pages.flatMap((p) => p.entries) ?? [];

  if (activity.isError) {
    return (
      <p role="alert" className="text-sm font-medium text-destructive">
        {errorMessage(activity.error)}
      </p>
    );
  }
  if (activity.isSuccess && entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label={label} className="flex flex-col gap-3">
        {entries.map((e) => (
          <li key={e.id} className="flex flex-col gap-0.5 text-sm" data-testid="activity-entry">
            <span>
              <span className="font-semibold">{actorName(e)}</span> {VERB[e.action]}
            </span>
            <span className="tabular text-muted-foreground">
              {[formatDateTime(e.at), e.ip].filter(Boolean).join(" · ")}
            </span>
            {e.userAgent && <span className="break-all text-muted-foreground">{e.userAgent}</span>}
          </li>
        ))}
      </ol>
      {activity.hasNextPage && (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          loading={activity.isFetchingNextPage}
          onClick={() => {
            void activity.fetchNextPage();
          }}
        >
          Show older activity
        </Button>
      )}
    </div>
  );
}
