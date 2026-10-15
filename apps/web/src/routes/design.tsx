import type { ReactNode } from "react";

import { Page } from "../components/page.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Field } from "../components/ui/field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";

const COLORS: readonly { token: string; use: string }[] = [
  { token: "background", use: "Paper. The page itself." },
  { token: "card", use: "A sheet lifted off the page." },
  { token: "foreground", use: "Ink. Body text and primary actions." },
  { token: "muted-foreground", use: "Pencil. Secondary text." },
  { token: "link", use: "Fountain-pen blue. Links and focus." },
  { token: "seal", use: "The signing seal. Used sparingly." },
  { token: "success", use: "Signed, complete." },
  { token: "warning", use: "Waiting on someone." },
  { token: "input", use: "Edges of things you can type in." },
  { token: "rule", use: "The margin line. Decoration only." },
];

const TYPE: readonly { label: string; className: string; sample: string }[] = [
  { label: "Display · Fraunces 48", className: "font-display text-5xl", sample: "Signed, sealed." },
  {
    label: "Title · Fraunces 30",
    className: "font-display text-3xl",
    sample: "Quarterly contract",
  },
  { label: "Heading · Fraunces 20", className: "font-display text-xl", sample: "Recipients" },
  {
    label: "Body · Atkinson Hyperlegible Next 16",
    className: "text-base",
    sample: "Atkinson was drawn for low-vision readers: 0O, 1lI and rn/m never blur together.",
  },
  {
    label: "Small · Atkinson 14",
    className: "text-sm text-muted-foreground",
    sample: "Last opened 3 minutes ago",
  },
  { label: "Numbers · tabular", className: "tabular text-base", sample: "Page 108 of 1,240" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 border-t py-10" aria-labelledby={slug(title)}>
      <h2 id={slug(title)} className="text-2xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

const slug = (s: string) => `ds-${s.toLowerCase().replaceAll(/\W+/g, "-")}`;

export function DesignRoute() {
  return (
    <Page
      title="Design system"
      lede="Paper and ink. Quiet surfaces so documents stay the loudest thing on screen, one red seal for the moments that matter, and type built for reading."
    >
      <div className="max-w-4xl">
        <Section title="Principles">
          <ul className="grid gap-4 md:grid-cols-3">
            {[
              ["The document leads", "Chrome stays warm and quiet; PDFs carry the color."],
              ["One seal", "Red marks only signing, required fields and danger. Never decoration."],
              ["Legible first", "AA contrast in both themes is a failing test, not a guideline."],
            ].map(([title, body]) => (
              <li key={title}>
                <Sheet className="h-full">
                  <SheetHeader>
                    <SheetTitle>{title}</SheetTitle>
                  </SheetHeader>
                  <SheetBody className="text-muted-foreground">{body}</SheetBody>
                </Sheet>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Color">
          <ul className="grid gap-3 sm:grid-cols-2">
            {COLORS.map((c) => (
              <li key={c.token} className="flex items-center gap-4 rounded-md border bg-card p-3">
                <span
                  aria-hidden="true"
                  className="size-12 shrink-0 rounded-sm border"
                  style={{ background: `var(--${c.token})` }}
                />
                <span className="flex flex-col">
                  <code className="font-mono text-sm">--{c.token}</code>
                  <span className="text-sm text-muted-foreground">{c.use}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Type">
          <dl className="flex flex-col gap-6">
            {TYPE.map((t) => (
              <div key={t.label} className="flex flex-col gap-1">
                <dt className="text-sm text-muted-foreground">{t.label}</dt>
                <dd className={t.className}>{t.sample}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-4">
            <Button>Send for signature</Button>
            <Button variant="secondary">Download</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Void envelope</Button>
            <Button variant="link">View audit trail</Button>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Sending…</Button>
          </div>
        </Section>

        <Section title="Status">
          <div className="flex flex-wrap gap-3">
            <Badge>Draft</Badge>
            <Badge variant="info">Sent</Badge>
            <Badge variant="warning">Waiting on 1 signer</Badge>
            <Badge variant="success">Signed</Badge>
            <Badge variant="danger">Voided</Badge>
          </div>
        </Section>

        <Section title="Fields">
          <form
            className="grid max-w-md gap-5"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <p className="text-sm text-muted-foreground">
              Fields marked <span className="text-seal">*</span> are required.
            </p>
            <Field label="Recipient name" required autoComplete="name" />
            <Field
              label="Email"
              type="email"
              hint="We email them a one-time code to confirm it’s them before they sign."
              autoComplete="email"
            />
            <Field
              label="Link password"
              type="password"
              defaultValue="abc"
              error="This password is too short. Use at least 8 characters."
              autoComplete="new-password"
            />
          </form>
        </Section>

        <Section title="Sheets">
          <div className="grid gap-4 sm:grid-cols-2">
            <Sheet folded>
              <SheetHeader>
                <SheetTitle>Lease agreement.pdf</SheetTitle>
                <p className="tabular text-sm text-muted-foreground">12 pages · 1.4 MB</p>
              </SheetHeader>
              <SheetBody className="flex items-center justify-between gap-3">
                <Badge variant="warning">Waiting on 1 signer</Badge>
                <Button variant="secondary" size="sm">
                  Open
                </Button>
              </SheetBody>
            </Sheet>
            <Sheet>
              <SheetHeader>
                <SheetTitle>Plain sheet</SheetTitle>
              </SheetHeader>
              <SheetBody className="text-muted-foreground">
                Sheets without a fold hold settings, summaries and anything that is not a document.
              </SheetBody>
            </Sheet>
          </div>
        </Section>

        <Section title="Empty state">
          <EmptyState
            title="No documents yet"
            action={<Button variant="secondary">Upload a PDF</Button>}
          >
            <p>
              Say what will appear here, why it is empty, and the one action that fills it. Leave
              the action out until the feature exists.
            </p>
          </EmptyState>
        </Section>
      </div>
    </Page>
  );
}
