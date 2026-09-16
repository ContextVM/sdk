---
'@contextvm/sdk': patch
---

Fix the CEP-41 `accept` frame being numbered at the client's `start` progress + 1 — the shared cross-peer sequence reading. Progress sequences are per-sender, so the server now sends `accept` at `progress: 1`, the first frame on its own outbound sequence. Receivers enforcing per-sender monotonicity no longer kill a healthy client-to-server stream when the server's later control frames (`pong`/`abort`, numbered on its own counter) arrive below the inflated accept watermark.
