---
'@contextvm/sdk': patch
---

fix(relay): bump applesauce-relay to 6.2.1 and simplify discardRelay

With applesauce-relay 6.2.1, `Relay.close()` is terminal: it cancels the reconnect timer, tears down internal watchers, and completes the watchTower source. This eliminates the previous workaround for manually completing `_ready$` and avoids potential race conditions during relay disposal.