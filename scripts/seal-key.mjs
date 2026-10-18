// Prints a new Document seal key pair (ADR-0006) as SEAL_PRIVATE_KEY and SEAL_CERTIFICATE
// PEMs on stdout, for `wrangler secret put`. Writes nothing to disk.
// usage: node scripts/seal-key.mjs [--subject "Inkly Document Seal"] [--json]
import { parseArgs } from "node:util";

import { generateSealKey } from "../packages/pdf/src/seal.ts";

const { values } = parseArgs({
  options: { subject: { type: "string" }, json: { type: "boolean" } },
});
const key = await generateSealKey(values.subject);
const secrets = { SEAL_PRIVATE_KEY: key.privateKeyPem, SEAL_CERTIFICATE: key.certificatePem };

if (values.json === true) {
  // `wrangler secret bulk` reads this shape.
  process.stdout.write(`${JSON.stringify(secrets, null, 2)}\n`);
} else {
  for (const [name, pem] of Object.entries(secrets)) process.stdout.write(`${name}:\n${pem}\n`);
}
