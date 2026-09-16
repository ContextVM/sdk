---
'@contextvm/sdk': patch
---

Make CEP-41 client-to-server streams work end to end and close the per-sender sequence gaps left by the accept-numbering fix:

- One shared per-sender outbound counter per stream on both transports. The server's bootstrap `accept`, writer frames (`start`/`chunk`/`close`/`ping`/`pong`/`abort`) and session control frames now draw from a single monotonic sequence, so a receiver enforcing per-sender monotonicity no longer sees duplicate progress values from the server (previously `accept@1` then `pong@1`).
- Keepalive pings on bootstrap tokens without a correlation route are answered instead of silently dropped; session control frames fall back to the frame's signer pubkey.
- A stream that fails on an inbound frame now publishes `abort` to the peer instead of dying silently, so the peer stops streaming into a dead stream (CEP-41).
- Every client session for a token now draws control-frame numbers from one shared per-sender sequence (sessions created through `getOrCreateOpenStreamSession` included), instead of an isolated per-session counter.
- New `NostrClientTransport.startOpenStream(progressToken)`: starts a client-to-server stream on a request's progress token — publishes `start` on the client's own outbound sequence, waits for the server's `accept` (CEP-41), and returns the paired session and payload writer sharing one per-sender sequence.
- Tool-side consumption: requests whose token carries a client-started stream expose a lazy chunk iterator as `_meta.inputStream` on the tool handler's `extra`, symmetric to the existing output `_meta.stream` writer. It resolves when the client's `start` arrives and ends when the client closes, including streams that complete before the tool starts reading.
