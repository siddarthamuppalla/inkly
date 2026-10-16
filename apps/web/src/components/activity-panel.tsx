import type { DocumentInfo } from "@inkly/domain";

import { useMe } from "../lib/session.ts";
import { ActivityList } from "./activity-list.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

/** The viewer's Activity panel: who opened, downloaded or changed this Document. */
export function ActivityPanel({ doc }: { readonly doc: DocumentInfo }) {
  const me = useMe();
  if (me?.role === "viewer") return null;
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Activity</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Views, downloads and changes by Members and share links.
        </p>
      </SheetHeader>
      <SheetBody>
        <ActivityList of="document" id={doc.id} label={`Activity on ${doc.title}`} />
      </SheetBody>
    </Sheet>
  );
}
