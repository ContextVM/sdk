'@contextvm/sdk': patch
---

`NostrClientTransport` records an unencrypted inbound event id only after its signature verifies, matching the server pipeline and the client's own encrypted path. Previously a copy with a corrupted signature that arrived first would mark the id, and the genuine copy would then be dropped as a duplicate.
