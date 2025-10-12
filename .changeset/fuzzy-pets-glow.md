---
'@contextvm/sdk': patch
---

fix(relay): update applesauce-relay to v4 and adapt API usage

- Update applesauce-relay dependency from v3.1.0 to v4.0.0
- Adapt RelayPool constructor to use new Relay API with publishTimeout
- Add detailed logging for better debugging of relay operations
- Add test case for handling offline relays in the pool
