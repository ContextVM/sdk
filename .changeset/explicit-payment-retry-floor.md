'@contextvm/sdk': patch
---

Floor the explicit-gating `-32042` payment retry at `minRetryDelayMs` (default 1s), mirroring the `-32043` retry. An instantly-satisfied payment callback could retry within the same second as the original request, producing a byte-identical Nostr event that servers de-duplicate by id, leaving the paid request unexecuted.
