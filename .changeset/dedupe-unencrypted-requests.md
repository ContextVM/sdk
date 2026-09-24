---
'@contextvm/sdk': patch
---

De-duplicate unencrypted inbound events by id on `NostrServerTransport`, as gift-wrapped events already were. The relay pool deliberately forwards every copy, so a plaintext request published to N relays was processed N times, and a non-idempotent tool ran N times for one call. The id is recorded only after the signature check, so a copy with a bad signature cannot suppress the genuine request. Retries are unaffected: they are newly signed events with new ids, and with the client nonce two distinct requests never share an id. Clients that predate the nonce keep the edge case encrypted requests already had: a repeat of an identical request within the same second is dropped.
