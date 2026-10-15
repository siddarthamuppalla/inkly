import { useId, type ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

export type SelectFieldProps = Omit<ComponentProps<"select">, "id"> & {
  readonly label: string;
};

/** A labelled native select, styled like Field's input. */
export function SelectField({ label, className, children, ...props }: SelectFieldProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <select
        id={id}
        className="h-11 rounded-md border border-input bg-card px-3 text-base text-card-foreground"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
