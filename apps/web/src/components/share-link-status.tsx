import { shareLinkStatus, type ShareLinkInfo, type ShareLinkStatus } from "@inkly/domain";

import { Badge } from "./ui/badge.tsx";

const BADGE: Record<ShareLinkStatus, { label: string; variant: "success" | "warning" | "danger" }> =
  {
    active: { label: "Active", variant: "success" },
    expired: { label: "Expired", variant: "warning" },
    revoked: { label: "Revoked", variant: "danger" },
  };

export function ShareLinkStatusBadge({ link }: { readonly link: ShareLinkInfo }) {
  const { label, variant } = BADGE[shareLinkStatus(link, Date.now())];
  return <Badge variant={variant}>{label}</Badge>;
}
