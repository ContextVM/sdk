---
'@contextvm/sdk': minor
---

Add bounded payment-adapter cancellation, authenticated settlement reconciliation, and retryable paid-result delivery through the injected `PaymentStateStore`.

The SDK bundles only in-memory storage and adds no storage-driver dependency. Result recovery with the default store requires keeping that same store alive; recovery across process restarts requires an application-provided persistent implementation. Retrying publication does not repeat payment or handler execution.
