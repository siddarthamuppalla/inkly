export interface WordmarkProps {
  readonly className?: string;
}

/** "Inkly" set in Fraunces with a seal-red drop of ink for the dot. */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <span className={className}>
      <span className="font-display text-2xl font-semibold italic tracking-tight">Inkly</span>
      <span aria-hidden="true" className="ml-0.5 inline-block size-2 rounded-full bg-seal" />
    </span>
  );
}
