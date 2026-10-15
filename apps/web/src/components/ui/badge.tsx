import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border border-current px-2.5 py-0.5 text-sm font-medium leading-5",
  {
    variants: {
      variant: {
        neutral: "text-muted-foreground",
        info: "text-link",
        success: "text-success",
        warning: "text-warning",
        danger: "text-destructive",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

/** A status mark. The label carries the meaning; color only reinforces it. */
export function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
