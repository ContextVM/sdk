---
"@contextvm/sdk": patch
---

Fix stale timestamp in queued NWC requests by capturing `nowSeconds()` inside the `run()` closure so the `created_at` field reflects when the event is actually built and signed, not when it was enqueued.
