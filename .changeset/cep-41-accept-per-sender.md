---
'@contextvm/sdk': patch
---

Align the CEP-41 open-stream `accept` frame with per-sender progress semantics: the server now sends `accept` at `progress: 1`, the first frame on its own outbound sequence, instead of the client's `start` progress + 1 (the shared cross-peer sequence reading, clarified away in CEP-41). No SDK receiver consumes the old value; the bootstrap e2e assertion pins the new numbering. Known limit, tracked separately: server outbound frames for a client-started stream still originate from independent counters (dispatcher `accept` vs stream `ping`/`pong`/`abort`), so a receiver enforcing per-sender monotonicity across all server frames can still see a duplicate progress value from the server until those counters are unified.
