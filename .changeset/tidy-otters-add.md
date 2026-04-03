---
'@contextvm/sdk': patch
---

refactor(transport): extract discovery tags into dedicated module and add client capability advertisement

Extract discovery tag parsing and merging logic into a new discovery-tags.ts module. Add client-side capability advertisement so clients can proactively advertise support for encryption, ephemeral gift wraps, and oversized transfers without waiting for server discovery. Also fix a race condition in the oversized transfer receiver where accept could arrive before waiter registration.

BREAKING CHANGE: The hasKnownDiscoveryTag function has been removed from nostr-client-transport.ts in favor of the new hasDiscoveryTags and parseDiscoveredPeerCapabilities functions.