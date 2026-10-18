import type { EnvelopeStatus, RecipientStatus } from "@inkly/domain";

import { Badge, type BadgeProps } from "../ui/badge.tsx";

type Variant = NonNullable<BadgeProps["variant"]>;

export const ENVELOPE_STATUS: Record<EnvelopeStatus, { label: string; variant: Variant }> = {
  draft: { label: "Draft", variant: "neutral" },
  sent: { label: "Sent", variant: "info" },
  completing: { label: "Completing", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  declined: { label: "Declined", variant: "danger" },
  voided: { label: "Voided", variant: "warning" },
  expired: { label: "Expired", variant: "warning" },
};

const RECIPIENT_STATUS: Record<RecipientStatus, { label: string; variant: Variant }> = {
  waiting: { label: "Waiting", variant: "neutral" },
  sent: { label: "Sent", variant: "info" },
  viewed: { label: "Viewed", variant: "info" },
  signed: { label: "Signed", variant: "success" },
  declined: { label: "Declined", variant: "danger" },
};

export function EnvelopeStatusBadge({ status }: { readonly status: EnvelopeStatus }) {
  const { label, variant } = ENVELOPE_STATUS[status];
  return (
    <Badge variant={variant} data-testid="envelope-status">
      {label}
    </Badge>
  );
}

export function RecipientStatusBadge({ status }: { readonly status: RecipientStatus }) {
  const { label, variant } = RECIPIENT_STATUS[status];
  return <Badge variant={variant}>{label}</Badge>;
}
