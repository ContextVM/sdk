---
'@contextvm/sdk': patch
---

Align the CEP-41 open-stream `accept` frame with per-sender progress semantics: the server now sends `accept` at `progress: 1`, the first frame on its own outbound sequence, instead of the client's `start` progress + 1 (the shared cross-peer sequence reading, clarified away in CEP-41). No SDK receiver consumes the old value; the bootstrap e2e assertion pins the new numbering. The counter-unification limit this changeset originally carried is resolved by the accompanying `cep-41-client-started-streams` changeset in the same release: all server frames for a stream (bootstrap `accept`, writer frames, session control frames) now share one per-sender counter.
