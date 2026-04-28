---
'@contextvm/sdk': patch
---

refactor(relay): make getRelayUrls required in RelayHandler interface

Changed getRelayUrls from optional to required method in RelayHandler interface.
Updated mock implementation and removed optional chaining in transport layer.