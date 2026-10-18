import { ENVELOPE_STATUSES, EnvelopeStatus } from "@inkly/domain";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { ENVELOPE_STATUS, EnvelopeStatusBadge } from "../components/envelopes/status-badge.tsx";
import { Page } from "../components/page.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { SelectField } from "../components/ui/select-field.tsx";
import { errorMessage } from "../lib/api.ts";
import { envelopeKeys, envelopesApi } from "../lib/envelopes-api.ts";
import { formatDateTime } from "../lib/format.ts";

export function EnvelopesRoute() {
  const [params, setParams] = useSearchParams();
  const parsed = EnvelopeStatus.safeParse(params.get("status"));
  const status = parsed.success ? parsed.data : null;
  const envelopes = useQuery({
    queryKey: envelopeKeys.list(status),
    queryFn: () => envelopesApi.list(status),
  });
  const rows = envelopes.data ?? [];

  return (
    <Page
      title="Envelopes"
      lede="Documents you have sent for signature, and where each one stands."
    >
      <div className="flex flex-col gap-6">
        <SelectField
          label="Show"
          className="w-full max-w-60"
          value={status ?? ""}
          onChange={(e) => {
            const next = e.currentTarget.value;
            setParams(next === "" ? {} : { status: next });
          }}
        >
          <option value="">All envelopes</option>
          {ENVELOPE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ENVELOPE_STATUS[s].label}
            </option>
          ))}
        </SelectField>
        {envelopes.isError && (
          <p role="alert" className="font-medium text-destructive">
            {errorMessage(envelopes.error)}
          </p>
        )}
        {envelopes.isSuccess && rows.length === 0 && (
          <EmptyState
            title={
              status
                ? `No ${ENVELOPE_STATUS[status].label.toLowerCase()} envelopes`
                : "No envelopes yet"
            }
          >
            <p>
              Open a document and choose Send for signature. An envelope is one document, its
              recipients and the fields they fill in. Its audit trail stays with it once everyone
              has signed.
            </p>
          </EmptyState>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Envelopes in this workspace</caption>
              <thead>
                <tr className="border-b text-sm text-muted-foreground">
                  {["Envelope", "Status", "Sent", "Updated"].map((h) => (
                    <th key={h} scope="col" className="py-2 pr-4 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b" data-testid="envelope-row">
                    <th scope="row" className="py-3 pr-4 font-normal">
                      <Link to={`/envelopes/${e.id}`} className="font-medium">
                        {e.title}
                      </Link>
                    </th>
                    <td className="py-3 pr-4">
                      <EnvelopeStatusBadge status={e.status} />
                    </td>
                    <td className="tabular py-3 pr-4">
                      {e.sentAt === null ? "Not yet" : formatDateTime(e.sentAt)}
                    </td>
                    <td className="tabular py-3 pr-4">{formatDateTime(e.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}
