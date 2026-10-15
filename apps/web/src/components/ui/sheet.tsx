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
        "relative rounded-md border bg-card text-card-foreground shadow-[0_1px_0_0_var(--border),0_12px_24px_-18px_rgb(0_0_0/0.35)]",
        folded &&
          "rounded-tr-none [clip-path:polygon(0_0,calc(100%-1.25rem)_0,100%_1.25rem,100%_100%,0_100%)] before:absolute before:right-0 before:top-0 before:size-5 before:rounded-bl-sm before:bg-muted before:content-['']",
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
