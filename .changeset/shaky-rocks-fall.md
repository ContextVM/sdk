---
'@contextvm/sdk': patch
---

fix(transport): resolve open-stream and progress token conflicts

Address a conflict where standard MCP progress tokens could be
incorrectly bound to existing open streams.

- Bind progress tokens synchronously in `ClientOutboundSender` to ensure
  deterministic behavior.
- Update `ServerOpenStreamFactory` to only defer responses if the
  `OpenStreamWriter` has actually started streaming.
- Add `hasStarted` to `OpenStreamWriter` to distinguish between an active
  writer and one that has emitted frames.