import type { ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

export type SheetProps = ComponentProps<"div"> & {
  /** Dog-ears the top-right corner, for surfaces that stand for a document. */
  readonly folded?: boolean;
};

/** A raised piece of paper: Inkly's card surface. */
export function Sheet({ className, folded = false, ...props }: SheetProps) {
  return (
    <div
      className={cn(
        "relative rounded-md border bg-card text-card-foreground shadow-sheet",
        folded &&
          "rounded-tr-none [clip-path:polygon(0_0,calc(100%-var(--fold))_0,100%_var(--fold),100%_100%,0_100%)] before:absolute before:right-0 before:top-0 before:size-(--fold) before:rounded-bl-sm before:bg-muted before:content-['']",
        className,
      )}
      {...props}
    />
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 p-6 pb-0", className)} {...props} />;
}

export function SheetTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-xl", className)} {...props} />;
}

export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-6", className)} {...props} />;
}
