import { testHooksOn } from "@inkly/auth";
import { AppError } from "@inkly/domain";
import { generateSealKey, importSealKey, type SealKey } from "@inkly/pdf";

import type { Env } from "../env.ts";

// The Document seal key (ADR-0006): the SEAL_PRIVATE_KEY / SEAL_CERTIFICATE secrets. With test
// hooks on (local dev, previews without secrets) and no secrets, one pair is generated per
// isolate. Production with no secrets has no key, so finalize refuses and the Workflow retries.

interface Loaded {
  readonly certificatePem: string;
  readonly key: SealKey;
}

let imported: { readonly pem: string; readonly loaded: Promise<Loaded> } | undefined;
let generated: Promise<Loaded> | undefined;

function configured(env: Env): { privateKeyPem: string; certificatePem: string } | null {
  const privateKeyPem = env.SEAL_PRIVATE_KEY?.trim() ?? "";
  const certificatePem = env.SEAL_CERTIFICATE?.trim() ?? "";
  return privateKeyPem && certificatePem ? { privateKeyPem, certificatePem } : null;
}

function load(env: Env): Promise<Loaded> | null {
  const secrets = configured(env);
  if (secrets) {
    const pem = `${secrets.privateKeyPem}\n${secrets.certificatePem}`;
    if (imported?.pem !== pem) {
      const loaded = importSealKey(secrets.privateKeyPem, secrets.certificatePem).then((key) => ({
        certificatePem: secrets.certificatePem,
        key,
      }));
      imported = { pem, loaded };
    }
    return imported.loaded;
  }
  if (!testHooksOn(env)) return null;
  generated ??= generateSealKey("Inkly Document Seal (test)").then((key) => ({
    certificatePem: key.certificatePem,
    key,
  }));
  return generated;
}

/** The key finalize seals with; an AppError when none is configured. */
export async function sealKey(env: Env): Promise<SealKey> {
  const loaded = load(env);
  if (!loaded) {
    throw new AppError(
      "internal",
      "No Document seal key is configured: set the SEAL_PRIVATE_KEY and SEAL_CERTIFICATE secrets",
    );
  }
  return (await loaded).key;
}

/** The seal certificate's PEM, which `GET /api/seal-certificate` publishes; null when none. */
export async function sealCertificatePem(env: Env): Promise<string | null> {
  const loaded = load(env);
  return loaded ? (await loaded).certificatePem : null;
}
