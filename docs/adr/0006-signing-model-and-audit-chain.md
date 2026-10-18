---
status: accepted
date: 2026-10-18
---

# 0006 — Signing model and the audit hash chain

Phase 3 adds e-signature: an **Envelope** is one Document Version, its Recipients and the
Fields they fill in. The legal target is a simple electronic signature (ESIGN, UETA,
eIDAS SES): we must show who signed, that they meant to, and that the signed bytes have
not changed since. Signers are not Users (ADR-0003).

## Decisions

### One writer per Envelope
- An `Envelope` Durable Object, named `{tenantId}/{envelopeId}`, is the only writer of the
  `envelopes`, `recipients`, `fields` and `audit_events` rows of its Envelope. It runs each
  mutation inside `blockConcurrencyWhile`, so the state machine and the hash chain never
  see two writers. The rows live in D1 (not DO storage) so the Tenant can list and search
  Envelopes; reads go through `@inkly/storage` like every other table.
- Writes go through the `@inkly/storage/envelopes` subpath, and lint lets only the
  Envelope DO module import it. `audit_events` has D1 triggers that abort any `UPDATE` or
  `DELETE`, so append-only holds even against a bug in the DO.
- The API Worker reaches the DO only after `requireTenant` and an Envelope lookup in the
  caller's Tenant (members), or after `packages/auth` resolves a signer token (signers).

### Lifecycle
`draft → sent → completing → completed`, with `declined`, `voided` and `expired` as the
other end states. A draft can be edited and deleted; once sent, recipients and fields are
frozen. The Envelope pins the Version it was drafted on; later edits to the Document do
not change what is being signed. On completion the sealed PDF becomes a new Version of
the Document.

A Cloudflare Workflow (`EnvelopeLifecycle`, one instance per sent Envelope, id = Envelope
id) owns time and retries: it reminds pending signers every 3 days, expires the Envelope
at `expires_at` (default 30 days after sending) and, when the DO reports every signer
done, runs the finalize step until it succeeds. The Workflow only calls DO methods; it
never writes rows itself. Each DO method is idempotent on the Envelope's status, so a
retried step converges.

### Signer access: link + email code
- Sending mints one 256-bit token per Recipient when it becomes their turn (all signers in
  `parallel` order; the next routing order in `sequential`). Only its sha256 is stored, in
  `recipients.token_hash`. The link is `/sign/{token}`. `packages/auth` is the only place a
  signer token becomes a `TenantId`, as with Share links.
- The link alone shows the Envelope's title and sender only. To see the Document or sign,
  the signer asks for a 6-digit code sent to the same address (10 minutes, at most 5 sends
  per Recipient per 10 minutes, 5 wrong tries per code). A right code sets a signed
  1-hour grant cookie bound to that Recipient. The code proves control of the inbox at
  signing time, so a forwarded link alone cannot sign.
- Signing requires ticking the electronic-records consent. The consent text, the
  signer's IP, user agent and the code check are audit events.
- CC recipients get a link only when the Envelope completes, to download the signed PDF.
  Every Recipient's link keeps downloading the signed PDF for 30 days after completion.

### Signature images
A signature or initials value is a PNG (at most 200 KB, data URL) the signer drew or
typed; the browser renders typed names in the design system's script face, so the
server has one path. Date fields take the signing date, never a client value.

### Audit hash chain
Each event of a subject (`envelope`) has `seq` 1, 2, 3, …, and

```
hash = hex(sha256(prev_hash + "\n" + canonical_json(event)))
```

where `prev_hash` is the previous event's `hash` (`"0" × 64` for `seq` 1) and
`canonical_json` is JSON with keys sorted, no whitespace, over `tenantId, subjectType,
subjectId, seq, actor, action, detail, ip, userAgent, at`. The function lives in
`packages/domain` and is the only implementation; the API's chain check and
`verify-signing` both call it. The `completed` event's detail carries the sha256 of the
sealed bytes, so the chain head commits to the output.

### Completion: stamp, certificate, seal
Finalize, in the Envelope DO: stamp every Field value into the pinned Version
(`packages/pdf`), append the **Certificate of completion** pages (Envelope, Document
sha256 before signing, each Recipient's name, email, verification method, IP, user agent
and times, every audit event with its hash), then apply a PAdES B-B **Document seal** (CMS
`ETSI.CAdES.detached`, ECDSA P-256, SHA-256) with the Inkly seal key. Sealing runs in the
Worker with WebCrypto and pkijs, so there is no Container round trip; `verify-signing`
checks the output with pyHanko and qpdf in CI.

The seal key is a PKCS#8 PEM in the Worker secret `SEAL_PRIVATE_KEY` and its self-signed
certificate in `SEAL_CERTIFICATE`; `GET /api/seal-certificate` publishes the certificate.
Previews generate a fresh pair per environment. Local dev and tests, where test hooks are
on and no secret is set, use a pair generated in memory. Production with no key refuses
to finalize (the Envelope stays `completing` and the Workflow retries), and a human sets
the production secrets before the Phase 3 deploy.

### Limits
Sending counts one Envelope against the Plan's monthly Limit (`usage.envelopes`; Free 3,
Pro 50), claimed atomically like page ops. Drafts are free.

## Consequences
- A tampered `audit_events` row breaks the chain from that row on, and the sealed PDF
  stops validating if a byte changes. Neither proves identity beyond control of an inbox
  (SES); AES/QES stay out of scope.
- One DO per Envelope keeps write contention local. D1 remains the store, so ADR-0007's
  sharding plan covers Envelopes too.
- The seal certificate is self-signed, so PDF readers show "validity unknown" until a
  certificate from a public CA (AATL) replaces it. Swapping it is a secret change only.

## Considered options
- **Envelope state in DO SQLite, mirrored to D1 for lists**: two stores to keep in step;
  rejected for MVP.
- **pyHanko in pdf-engine for sealing**: a Python runtime in the image and a Job per
  completion for something WebCrypto does in milliseconds; kept for validation only.
- **Durable Object alarms instead of Workflows**: fewer moving parts, but no step retries
  or history; the roadmap asks for Workflows, and they keep the DO free of timers.
