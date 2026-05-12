---
'@contextvm/sdk': patch
---

refactor(transport): measure final published event size for oversized transfer decisions

Instead of checking the logical JSON-RPC message size, the transport now measures the final published Nostr event size (including encryption, gift wrapping, and tags) when deciding to switch to oversized transfer and calculating safe chunk sizes. This ensures accurate threshold enforcement and prevents relay rejections due to oversized events.

- Add `buildPublishedMcpEvent`, `buildPublishedEventFromSignedEvent`, `measurePublishedMcpMessageSize`, and `resolveSafeOversizedChunkSize` methods to base transport
- Update client and server transports to use published event size for threshold checking
- Use binary search in `resolveSafeOversizedChunkSize` to derive optimal per-chunk budget
- Add tests verifying published event size measurement and chunk size derivation