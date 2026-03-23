---
'@contextvm/sdk': patch
---

refactor(transport): rename isPublicServer to isAnnouncedServer

Rename the `isPublicServer` option to `isAnnouncedServer` to better reflect its purpose of publishing public announcement events on Nostr for relay-based discovery. The old option is deprecated but still supported for backward compatibility.