---
'@contextvm/sdk': minor
---

Prevent duplicate payment offers and stale authorization changes using atomic, generation-fenced payment state and a retained transparent-request replay ledger.

**Breaking change:** `AuthorizationStore` now implements the asynchronous `PaymentStateStore` contract (`admit`, `transition`, and `read`). Replace the former synchronous grant/claim/pending/clear methods and `maxEntries` option with the atomic store operations and `PaymentStatePolicy` limits. Inject the store through `ServerPaymentsOptions.stateStore`; both payment modes must use the same store.

The SDK bundles only an in-memory store, with no added storage dependencies. One paying server identity must run in one process with a shared store. Restarts lose its invoice bindings, grants, and replay records. Applications needing persistence or cross-process coordination can inject their own `PaymentStateStore` and manage its dependencies and lifecycle.

Server quotes and processor output are validated before payment or execution. Expired paid grants return `payment_expired` with instructions to reconcile the payment rather than request another payment automatically.

Client and server boundaries share a non-empty, 2,048-character PMI schema. Identifiers are opaque and matched exactly, preserving custom rails and supporting HTTPS method identifiers without adding a protocol grammar restriction.
