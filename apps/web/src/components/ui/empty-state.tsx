import type { ReactNode } from "react";

import { Signature } from "../brand/signature.tsx";

export interface EmptyStateProps {
  readonly title: string;
  readonly children: ReactNode;
  /** The one thing the user can do to fill this page. Omit until that action exists. */
  readonly action?: ReactNode;
}

/** A blank page waiting for its first mark. */
export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <Signature className="h-14 w-48 text-link" />
      <h2 className="text-2xl">{title}</h2>
      <div className="max-w-prose text-muted-foreground">{children}</div>
      {action}
    </div>
  );
}
