import type { ReactNode } from "react";

export interface PageProps {
  readonly title: string;
  readonly lede?: string;
  readonly children: ReactNode;
}

export function Page({ title, lede, children }: PageProps) {
  return (
    <>
      <title>{`${title} · Inkly`}</title>
      <div className="mb-8 flex max-w-3xl flex-col gap-2">
        <h1 tabIndex={-1} className="text-4xl outline-none md:text-5xl">
          {title}
        </h1>
        {lede && <p className="text-lg text-muted-foreground">{lede}</p>}
      </div>
      {children}
    </>
  );
}
