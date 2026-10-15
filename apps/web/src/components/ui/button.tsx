import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium",
    "transition-[transform,box-shadow,background-color] duration-150 ease-out",
    "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        // The ink stamp: a hard seal-red offset that presses flat on click.
        primary:
          "bg-primary text-primary-foreground shadow-[3px_3px_0_0_var(--seal)] hover:shadow-[4px_4px_0_0_var(--seal)] hover:-translate-x-px hover:-translate-y-px active:translate-x-[3px] active:translate-y-[3px] active:shadow-none",
        secondary:
          "border border-input bg-card text-card-foreground hover:bg-secondary hover:text-secondary-foreground",
        ghost: "text-foreground hover:bg-muted",
        destructive:
          "bg-destructive text-destructive-foreground hover:shadow-[3px_3px_0_0_var(--foreground)]",
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

export type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
