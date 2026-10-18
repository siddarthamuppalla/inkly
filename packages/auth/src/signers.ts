import { mintShareToken } from "./share-links.ts";

// T3.1: Signer links (ADR-0006). A token carries 256 random bits like a Share-link token, and
// only its sha256 is stored, in recipients.token_hash. T3.3 adds resolving a token here, the
// only place a signer token becomes a TenantId.

/** A new signer token (sent once, in the `/sign/{token}` link) and the sha256 that is stored. */
export function mintSignerToken(): Promise<{ token: string; tokenHash: string }> {
  return mintShareToken();
}
