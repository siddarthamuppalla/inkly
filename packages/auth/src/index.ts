export { mayChangeAnnotation, type AnnotationChange } from "./annotations.ts";
export { googleConfigured } from "./better-auth.ts";
export {
  cloudflareSender,
  emailSender,
  outboxSender,
  readOutbox,
  resendSender,
  type EmailProvider,
  type EmailSender,
  type Mail,
} from "./email.ts";
export { testHooksOn, type AuthEnv } from "./env.ts";
export { handleAuthRequest, CODE_REQUEST_LIMIT, CODE_REQUEST_WINDOW_MS } from "./handler.ts";
export { mintDocumentId, mintEnvelopeId, mintFieldId, mintJobId, mintRecipientId } from "./ids.ts";
export {
  issueSignerGrant,
  mintSignerToken,
  mintSigningCode,
  resolveSignerToken,
  signerVerified,
  signingCodeMatches,
  signingCodeSendAllowed,
  type GoneSigner,
  type OpenSigner,
  type ResolvedSigner,
  type SignedSigner,
} from "./signers.ts";
export { tenantOfLifecycle, tenantOfQueuedJob } from "./queue.ts";
export { expireSeededSession, readAccessLog, seedAccount, type SeededAccount } from "./seed.ts";
export {
  authenticate,
  isRole,
  liveSessionActive,
  resolveTenant,
  ROLES,
  type Role,
  type Session,
  type TenantResolution,
} from "./session.ts";
export {
  acceptInvitation,
  describeMe,
  inviteMember,
  removeMember,
  switchTenant,
  type Me,
  type TenantSummary,
} from "./workspace.ts";
export {
  hashSharePassword,
  issueShareGrant,
  mintShareLinkId,
  mintShareToken,
  resolveShareLink,
  shareLinkUnlocked,
  unlockAttemptAllowed,
  verifySharePassword,
  UNLOCK_ATTEMPT_LIMIT,
  type GoneShareLink,
  type OpenShareLink,
} from "./share-links.ts";
