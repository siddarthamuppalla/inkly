import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

export const buttonVariants = cva(
  [
    // The transparent border becomes visible in Windows forced-colors mode, where fills vanish.
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent font-medium",
    "transition-[transform,box-shadow,background-color]",
    "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        // The ink stamp: a hard seal-red offset that presses flat on click.
        primary:
          "bg-primary text-primary-foreground shadow-stamp hover:shadow-stamp-lift hover:-translate-x-px hover:-translate-y-px active:translate-x-[3px] active:translate-y-[3px] active:shadow-none",
        secondary:
          "border border-input bg-card text-card-foreground hover:bg-secondary hover:text-secondary-foreground",
        ghost: "text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:shadow-stamp-ink",
        link: "h-auto px-0 text-link underline underline-offset-4 decoration-1 hover:decoration-2",
      },
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-11 px-5 text-base",
        lg: "h-12 px-6 text-lg",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Shows an ink-drop spinner, blocks clicks and tells assistive tech the action is running. */
    readonly loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  type = "button",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="size-3 animate-pulse rounded-full bg-current motion-reduce:animate-none"
        />
      )}
      {children}
    </button>
  );
}
