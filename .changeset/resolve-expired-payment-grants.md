---
'@contextvm/sdk': minor
---

Add the generation-fenced `resolve_expired_grant` storage transition for trusted operator confirmation that an expired, unclaimed payment was resolved outside the SDK. It requires an application-selected `retentionMs`, measured from grant expiry, with no SDK default.

Unresolved grants remain pinned. Resolved grants are collected on a later admission only after the configured horizon, invoice expiry, and replay deadlines have passed. Untimed transports retain records indefinitely. The operation never refunds, restores execution rights, or executes a handler; new invocations after collection use normal pricing and payment approval.

Custom `PaymentStateStore` backends using this operation must implement it atomically and persist `grantResolvedAtMs` with the record. Repeated or stale-generation resolution cannot alter the recorded deadline.
