---
"@contextvm/sdk": patch
---

Fix NWC relay subscriptions not being cleaned up when a request times out by moving the `.finally()` cleanup onto the `withTimeout()` promise instead of the inner promise, so the subscription is closed regardless of whether the timeout or the relay response wins the race.
