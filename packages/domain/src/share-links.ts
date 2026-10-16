import { z } from "zod";

// Share links (T2.3): request and response shapes shared by workers/api and apps/web.

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const SHARE_PASSWORD_MIN = 8;

export const ShareLinkCreate = z.object({
  documentId: Id,
  /** Epoch ms; null never expires (Pro only). */
  expiresAt: z.number().int().nullable(),
  password: z.string().min(SHARE_PASSWORD_MIN).max(200).nullable().default(null),
  allowDownload: z.boolean().default(true),
});
export type ShareLinkCreate = z.infer<typeof ShareLinkCreate>;

export const ShareUnlock = z.object({ password: z.string().min(1).max(200) });

export type ShareLinkStatus = "active" | "expired" | "revoked";

/** Whether a link still opens at `now`: revoked wins over expired. */
export function shareLinkStatus(
  link: { readonly expiresAt: number | null; readonly revokedAt: number | null },
  now: number,
): ShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (link.expiresAt !== null && link.expiresAt <= now) return "expired";
  return "active";
}

export const ShareLinkInfo = z.object({
  id: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  hasPassword: z.boolean(),
  allowDownload: z.boolean(),
  revokedAt: z.number().nullable(),
  opens: z.number().int(),
  lastOpenedAt: z.number().nullable(),
});
export type ShareLinkInfo = z.infer<typeof ShareLinkInfo>;

export const ShareLinkListResponse = z.object({ links: z.array(ShareLinkInfo) });
/** The token is in `url` and is shown this once; only its sha256 is stored. */
export const ShareLinkCreatedResponse = z.object({ link: ShareLinkInfo, url: z.string() });
export const ShareLinkResponse = z.object({ link: ShareLinkInfo });

/** What a share-link visitor learns about the Document before (and after) unlocking. */
export const SharedDocument = z.object({
  title: z.string(),
  pages: z.number().int(),
  allowDownload: z.boolean(),
  /** True while the link has a password and this browser has not unlocked it. */
  locked: z.boolean(),
});
export type SharedDocument = z.infer<typeof SharedDocument>;
