---
'@contextvm/sdk': patch
---

Stop signing throwaway events during CEP-22 oversized size probing. `measurePublishedMcpMessageSize` built and signed the real event via the configured signer just to measure its serialized length, so every progress-token request paid an extra `getPublicKey`+`signEvent` round trip (an approval prompt for NIP-07/NIP-55 users, a billed remote operation for NIP-46 bunkers), and the oversized chunk-size binary search multiplied that ~16x; the server response path had the same problem. Sizing now builds a placeholder event — pubkey/id/sig are fixed-length hex and NIP-44 v2 padding is deterministic given plaintext length, so the measured size is byte-identical without touching the signer. Also splits oversized chunks on UTF-8 byte boundaries instead of per-character encoding (~60x faster on MB-scale payloads).
