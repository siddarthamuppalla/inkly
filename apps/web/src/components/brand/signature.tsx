export interface SignatureProps {
  readonly className?: string;
}

/** A hand-drawn signature stroke in fountain-pen blue. Decorative only. */
export function Signature({ className }: SignatureProps) {
  return (
    <svg
      viewBox="0 0 240 70"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M6 50c14-4 22-30 30-34 7-3 3 30 8 31 6 1 12-24 18-23 5 1-2 22 4 22 7 0 10-16 16-15 5 1 2 13 7 13 8 0 14-20 22-20 7 0 0 21 8 21 10 0 16-16 26-16 8 0 6 10 14 10 9 0 20-6 30-12"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M40 62h160" stroke="var(--rule)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
