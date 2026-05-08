---
'@contextvm/sdk': patch
---

refactor(relay): process relay pings individually with proper cleanup

Refactor the ping mechanism to process each relay separately instead of using a merged stream. Each relay now gets a unique ping ID and its own subscription that is properly cleaned up with a CLOSE message in a finally block. This ensures better isolation between relay pings and prevents potential race conditions when multiple relays respond.