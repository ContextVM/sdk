---
'@contextvm/sdk': minor
---

Make CEP-41 client-to-server streams work end to end and close the per-sender sequence gaps left by the accept-numbering fix:

- One shared per-sender outbound counter per stream on both transports. The server's bootstrap `accept`, writer frames (`start`/`chunk`/`close`/`ping`/`pong`/`abort`) and session control frames now draw from a single monotonic sequence, so a receiver enforcing per-sender monotonicity no longer sees duplicate progress values from the server (previously `accept@1` then `pong@1`).
- Keepalive pings on bootstrap tokens without a correlation route are answered instead of silently dropped; session control frames fall back to the frame's signer pubkey.
- A stream that fails on an inbound frame now publishes `abort` to the peer instead of dying silently, so the peer stops streaming into a dead stream (CEP-41).
- New `NostrClientTransport.startOpenStream(progressToken)` API: starts a client-to-server stream on a request's progress token — creates the session that receives the server's `accept` and control frames and publishes `start` as the first frame on the client's own outbound sequence. Tool-side consumption of client-streamed chunks is not included in this release.
