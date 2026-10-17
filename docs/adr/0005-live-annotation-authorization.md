# ADR 0005: Reauthorize live annotation recipients

Status: accepted for T2.2 (#41).

A WebSocket upgrade authenticates one request, but its hibernating socket can outlive a
session, workspace membership, or accessible Document. Upgrade authorization alone let
former Members and signed-out or expired sessions continue receiving annotation data.
Trashed Documents also remained reachable through annotation routes.

The API forwards the authenticated session's database id, User id, Tenant id, Document id
and display Author. A DocSession verifies that scope against its own deterministic id.
Its hibernation attachment retains only those values; it never stores a cookie or bearer
token. Before each outgoing annotation, deletion or presence frame, it rechecks the exact
session's existence and expiry through `packages/auth`, the exact Tenant membership
(without fallback to another workspace), and the nontrashed Document through
`packages/storage`. Disallowed or old-format sockets close with policy code 1008. The
HTTP annotation routes also refuse trashed Documents with logged 404 responses.

Writes remain in the Document's SQLite Durable Object. Async authorization runs before
fanout; concurrency blocking preserves mutation notification order during those reads.
Presence is built only from recipients that passed the same checks. No authorization
result is cached across frames. Quiet sockets can continue their hibernating ping/pong,
but cannot receive subsequent Document data or presence after access ends. This keeps
hibernation without an always-running authorization timer.

The cost is three indexed D1 reads per live recipient per broadcast (session, membership,
Document) rather than trusting indefinitely retained permissions. There is no extra R2
read, poll timer or migration. For MVP workspace sizes this favors revocation correctness;
larger fanout will need measured query batching before increasing concurrency. Changes
to the auth tables or expiry representation must retain the integration regressions.
