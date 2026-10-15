import { useId, type ComponentProps } from "react";

import { cn } from "../../lib/cn.ts";

export type FieldProps = Omit<ComponentProps<"input">, "id"> & {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
};

/** Label, input, hint and error wired together so assistive tech reads them as one. */
export function Field({ label, hint, error, required, className, ...props }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
        {required && (
          <span className="text-seal" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "h-11 rounded-md border border-input bg-card px-3 text-base text-card-foreground",
          "placeholder:text-muted-foreground aria-invalid:border-destructive aria-invalid:border-2",
        )}
        {...props}
      />
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
