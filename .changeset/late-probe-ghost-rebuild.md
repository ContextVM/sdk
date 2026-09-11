---
'@contextvm/sdk': patch
---

Fix `ApplesauceRelayPool` resurrection after `disconnect()`: a liveness probe pending across terminal teardown could time out afterwards and run `rebuild()` on the dead pool, recreating `Relay` objects, observers, and an immortal ping-monitor interval (created after `destroy$.complete()`, so `takeUntil` never stops it). `rebuild()` now guards on the lifecycle `AbortController` signal that `disconnect()` aborts, so late probe timeouts are no-ops.
