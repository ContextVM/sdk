---
'@contextvm/sdk': patch
---

refactor(transport): extract outbound tag composition into base class

Extract the logic for composing outbound Nostr tags into a reusable
`composeOutboundTags` method in BaseNostrTransport. This standardizes
tag ordering across client and server transports (base tags first,
then discovery tags, then negotiation tags).

Refactor NostrClientTransport and NostrServerTransport to use the
shared composition method, and add `chooseServerOutboundGiftWrapKind`