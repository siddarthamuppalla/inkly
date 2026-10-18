---
name: verify-signing
description: Drive one two-signer Envelope through the API to completion, then fail unless the sealed PDF passes qpdf and pyHanko against /api/seal-certificate, has the original pages plus the Certificate of completion, holds the stamped text, and its audit chain and completed sha256 match. Use for any change to Envelopes, signing, packages/pdf stamping or sealing, and in CI.
---

# verify-signing

Gate for ADR-0006 (signing model and audit chain). Against local `wrangler dev` (started
for you) or a preview, it:

1. seeds a Tenant through `/__test/seed` and uploads `fixtures/pdfs/10p.pdf`;
2. drafts an Envelope with two **sequential** signers (Ana: signature, text, date on page 1;
   Ben: initials, signature, text on page 2), reads the pinned Version's page count from
   `GET /api/envelopes/:id/content`, and sends it;
3. checks Ben has no link yet, then signs as Ana and as Ben through `/api/sign/:token`: the
   link and the 6-digit Signing code come from the Outbox (`/__test/outbox`);
4. polls until the Envelope is `completed`, downloads `GET /api/envelopes/:id/content`
   and `GET /api/seal-certificate`, and confirms Ana's completion link serves the same bytes;
5. reads `GET /api/envelopes/:id/audit`.

It prints each step's time and the total for "upload → 2 signers → signed PDF +
certificate", then these checks. Any FAIL fails the run:

| Check | Passes when |
|-------|-------------|
| `qpdf` | `qpdf --check` exits 0 on the signed PDF |
| `seal` | `pyhanko sign validate`, trusting only the `/api/seal-certificate` PEM, reports every signature `INTACT:TRUSTED,UNTOUCHED` |
| `pages` | page count = the original's + the Certificate of completion pages (pages headed "Certificate of completion"), at least one, all after the original pages |
| `stamped-text` | every text value the signers typed and the date the server filled are in the original pages' text (`pdftotext`) |
| `audit-chain` | `verifyChain` (packages/domain) over the returned events is valid and its head equals `chain.head` from `GET …/audit`, which also says `valid` |
| `completed-sha256` | the last event is `completed` and its `detail.sha256` is the sha256 of the downloaded bytes |

The signed PDF and seal PEM are kept in `artifacts/verify-signing/`.

## When to run it
- Any change to `workers/api/src/envelope*`, `workers/api/src/signing.ts`, `packages/pdf`
  stamping, certificate or seal code, `packages/domain` audit or signing code.
- CI runs it and `--self-test` on every PR; `preview.yml` runs it against the preview.

## Usage
```
.claude/skills/verify-signing/run.sh                          # local wrangler dev
.claude/skills/verify-signing/run.sh --url URL --secret S     # e.g. a preview
.claude/skills/verify-signing/run.sh --self-test
```

| Flag | Meaning |
|------|---------|
| `--url URL` | Target a running environment instead of starting `wrangler dev`. It needs test hooks (seed, Outbox) enabled there. |
| `--secret S` | That environment's test-hooks secret. Defaults to `$TEST_HOOKS_SECRET`. |
| `--self-test` | After a passing run, breaks copies of the result and exits 0 only if each is caught: a tampered byte inside the signed range (`seal`, `completed-sha256`), a changed `signed` event (`audit-chain`), the Certificate of completion pages removed (`pages`) and no seal certificate (`seal`). The unchanged result must pass first. Combine with `--url` to self-test a preview. |
| `-h`, `--help` | Print usage. |

Exit codes: `0` pass, `1` any failed check or a step that did not happen (an
inconclusive run is a failure).

Needs `qpdf`, `poppler-utils` (`pdfinfo`, `pdftotext`) and pyHanko
(`pip install -r .claude/skills/verify-pdf/requirements.txt`).

## Code
`packages/testing/src/signing/drive.ts` (the API flow), `check.ts` (the checks and
self-test cases, unit-tested in `packages/testing/test/verify-signing.test.ts`), and
`packages/testing/bin/verify-signing.ts`. The browser version of the same flow is
`verify-app J-017`.
