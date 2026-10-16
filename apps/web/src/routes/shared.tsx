import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { useParams } from "react-router";

import { Wordmark } from "../components/brand/wordmark.tsx";
import { Page } from "../components/page.tsx";
import { PageCanvas, usePdf } from "../components/pdf-pages.tsx";
import { buttonVariants } from "../components/ui/button.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field } from "../components/ui/field.tsx";
import { ApiError, errorMessage } from "../lib/api.ts";
import { formatPages } from "../lib/format.ts";
import { shareLinksApi } from "../lib/share-links-api.ts";

// /s/:token, for signed-out visitors: no app shell, no session, no annotations.

const sharedKey = (token: string) => ["shared", token] as const;

export function SharedRoute() {
  const { token = "" } = useParams();
  const shared = useQuery({
    queryKey: sharedKey(token),
    queryFn: () => shareLinksApi.shared(token),
    retry: false,
  });

  return (
    <div className="min-h-dvh" data-testid="shared-page">
      <meta name="referrer" content="no-referrer" />
      <meta name="robots" content="noindex" />
      <header className="border-b px-5 py-4">
        <Wordmark />
      </header>
      <main id="main" className="margin-rule mx-4 my-8 pl-6 md:mx-12 md:my-12 md:pl-10">
        {shared.isError && <Gone error={shared.error} />}
        {shared.data?.locked === true && <Unlock token={token} onUnlocked={shared.refetch} />}
        {shared.data?.locked === false && (
          <SharedViewer
            token={token}
            title={shared.data.title}
            pages={shared.data.pages}
            allowDownload={shared.data.allowDownload}
          />
        )}
      </main>
    </div>
  );
}

function Gone({ error }: { readonly error: unknown }) {
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <Page title={gone ? "This link is no longer available" : "This link could not be opened"}>
      <p className="max-w-prose text-muted-foreground">
        {gone
          ? "Ask the person who shared it with you for a new link."
          : "Check your connection and reload the page."}
      </p>
    </Page>
  );
}

function Unlock({
  token,
  onUnlocked,
}: {
  readonly token: string;
  readonly onUnlocked: () => Promise<unknown>;
}) {
  const [password, setPassword] = useState("");
  const unlock = useMutation({
    mutationFn: () => shareLinksApi.unlock(token, password),
    onSuccess: onUnlocked,
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    unlock.mutate();
  }
  return (
    <Page title="This document is protected" lede="Enter the password you were given to open it.">
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.currentTarget.value);
          }}
          {...(unlock.isError ? { error: errorMessage(unlock.error) } : {})}
        />
        <Button type="submit" className="self-start" loading={unlock.isPending}>
          Open document
        </Button>
      </form>
    </Page>
  );
}

function SharedViewer({
  token,
  title,
  pages,
  allowDownload,
}: {
  readonly token: string;
  readonly title: string;
  readonly pages: number;
  readonly allowDownload: boolean;
}) {
  const content = useQuery({
    queryKey: ["shared-content", token],
    queryFn: () => shareLinksApi.content(token),
    staleTime: Infinity,
    retry: false,
  });
  const { pdf, error } = usePdf(content.data);
  const numbers = pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : [];

  return (
    <Page title={title} lede={`${formatPages(pages)} · Shared with you through Inkly`}>
      <div className="flex flex-col gap-6">
        {allowDownload && (
          <a
            href={shareLinksApi.downloadUrl(token)}
            download={`${title}.pdf`}
            className={buttonVariants({ className: "self-start no-underline" })}
          >
            Download
          </a>
        )}
        {(content.isError || error) && (
          <p role="alert" className="font-medium text-destructive">
            This PDF could not be displayed.
          </p>
        )}
        {!pdf && !content.isError && !error && (
          <p role="status" className="text-muted-foreground">
            Loading pages…
          </p>
        )}
        {pdf &&
          numbers.map((n) => (
            <figure key={n} className="flex flex-col gap-2">
              <PageCanvas
                pdf={pdf}
                pageNumber={n}
                width={800}
                label={`Page ${String(n)} of ${String(numbers.length)}`}
                testId="page"
                className="h-auto w-full max-w-[800px] border bg-card shadow-sheet"
              />
              <figcaption className="text-sm text-muted-foreground">
                Page {n} of {numbers.length}
              </figcaption>
            </figure>
          ))}
      </div>
    </Page>
  );
}
