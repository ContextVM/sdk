---
'@contextvm/sdk': patch
---

Prevent relay reconnects from dispatching previously seen server requests again after deduplication cache eviction. Retain verified plaintext and decrypted inner-event IDs until the server transport closes, while keeping envelope deduplication bounded as a decryption optimization. This also suppresses replay through a new envelope containing an old signed inner event.

Replay-protection memory now grows with unique verified inbound events, including notifications, transfer frames, and events rejected after signature verification. Newly signed events remain distinct requests. This protection does not persist across transport closure or process restart, cache responses, or guarantee exactly-once side effects; applications still need idempotency for retries.
