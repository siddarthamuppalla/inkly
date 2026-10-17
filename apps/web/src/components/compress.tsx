import type { CompressLevel, DocumentInfo, JobInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/format.ts";
import { jobFinished, jobsApi } from "../lib/jobs-api.ts";
import { queryClient, refreshAll } from "../lib/queries.ts";
import { Button } from "./ui/button.tsx";
import { SelectField } from "./ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

const LEVELS: readonly { value: CompressLevel; label: string }[] = [
  { value: "screen", label: "Smallest file" },
  { value: "ebook", label: "Balanced" },
  { value: "printer", label: "Best quality" },
];

const POLL_MS = 1500;

function savings(before: number, after: number): string {
  const percent = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  return `${formatBytes(before)} → ${formatBytes(after)} (${String(percent)}% smaller)`;
}

function JobStatus({ job }: { readonly job: JobInfo }) {
  if (job.status === "failed") {
    return (
      <p role="alert" className="text-sm font-medium text-destructive">
        {job.error ?? "Compression failed."}
      </p>
    );
  }
  let text: string;
  if (job.status === "queued") text = "Waiting to compress…";
  else if (job.status === "running") text = "Compressing…";
  else if (job.output?.version == null) text = "This PDF is already as small as it gets.";
  else {
    text = `Compressed into version ${String(job.output.version)}: ${savings(job.output.bytesBefore, job.output.bytesAfter)}.`;
  }
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

/** Compress the current Version in pdf-engine, then show the Job until it finishes. */
export function CompressPanel({ doc }: { readonly doc: DocumentInfo }) {
  const [level, setLevel] = useState<CompressLevel>("ebook");
  const [jobId, setJobId] = useState<string | null>(null);

  // After a reload, pick up a Job on this Document that is still in progress.
  const recent = useQuery({
    queryKey: ["jobs", doc.id],
    queryFn: () => jobsApi.documentJobs(doc.id),
    enabled: jobId === null,
  });
  const resumable = recent.data?.find((j) => !jobFinished(j));
  const tracked = jobId ?? resumable?.id ?? null;

  const job = useQuery({
    queryKey: ["job", tracked],
    queryFn: () => jobsApi.job(tracked ?? ""),
    enabled: tracked !== null,
    refetchInterval: (q) => (q.state.data && jobFinished(q.state.data) ? false : POLL_MS),
  });

  const succeeded = job.data?.status === "succeeded";
  useEffect(() => {
    if (succeeded) void refreshAll();
  }, [succeeded]);

  const start = useMutation({
    mutationFn: () => jobsApi.compress(doc.id, level),
    onSuccess: (started) => {
      // A retried Job keeps its id: seed its status so polling starts again.
      queryClient.setQueryData(["job", started.id], started);
      setJobId(started.id);
    },
  });
  const busy = start.isPending || (job.data !== undefined && !jobFinished(job.data));

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Compress</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Makes the file smaller as a new version; the current version stays in history.
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-3">
        <SelectField
          label="Quality"
          value={level}
          onChange={(e) => {
            setLevel(e.currentTarget.value as CompressLevel);
          }}
        >
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </SelectField>
        <Button
          variant="secondary"
          loading={busy}
          disabled={doc.deletedAt !== null}
          onClick={() => {
            start.mutate();
          }}
        >
          Compress
        </Button>
        <div aria-live="polite" data-testid="compress-status">
          {job.data && <JobStatus job={job.data} />}
        </div>
        {start.isError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {start.error instanceof ApiError
              ? start.error.message
              : "Something went wrong. Try again."}
          </p>
        )}
      </SheetBody>
    </Sheet>
  );
}
