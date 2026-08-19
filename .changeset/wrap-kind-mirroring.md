---
'@contextvm/sdk': patch
---

Mirror the request's gift-wrap kind on all server send paths in `GiftWrapMode.OPTIONAL`.

Previously only `route()` mirrored the wrap kind recorded for the client's request; `routeTargeted()`, `sendNotification()` (progress notifications), and the CEP-22 oversized accept frame all defaulted to the persistent gift wrap (kind 1059). A client that sent its request as an ephemeral gift wrap (kind 21059) without advertising the `support_encryption_ephemeral` capability tag could therefore get relay-stored replies — including the `-32042`/`-32043` explicit-gating errors that are frequently the first message a stateless client receives. Content was already NIP-44 encrypted either way; the divergence only affected relay persistence and metadata exposure.

All server outbound forms now mirror: targeted and correlated-notification paths look up the wrap kind from the recorded request route, and the accept frame threads the inbound wrap kind directly (no route exists at start-frame time). Also: `route()`'s send-failure retry now restores the full route including the signed request event, duplicated wrap-kind ternaries in the inbound coordinator were extracted into one `mirrorRequestWrapKind()` helper, and a debug-level tripwire logs hint-less encrypted sends in OPTIONAL mode so future unmirrored paths are grep-visible. No behavior change for sessions with the ephemeral capability tag, pinned `EPHEMERAL`/`PERSISTENT` policies, or unencrypted transports.
