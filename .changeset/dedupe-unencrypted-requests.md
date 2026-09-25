---
'@contextvm/sdk': patch
---

De-duplicate unencrypted inbound events by id on `NostrServerTransport`, as gift-wrapped events already were. The relay pool deliberately forwards every copy, so a plaintext request published to N relays was processed N times, and a non-idempotent tool ran N times for one call. The id is recorded only after the signature check, so a copy with a bad signature cannot suppress the genuine request. Retries that sign a new event in a later second get a new id and are unaffected; a byte-identical repeat of a request within the same second is dropped, the same edge case encrypted requests already had. The same dedup also protects against re-delivery on relay reconnects: subscriptions keep their original `since`, so resubscribes replay events the transport has already processed.
