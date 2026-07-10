---
'@contextvm/sdk': patch
---

refactor: remove deprecated NIP-04, unused queue methods, simplify base64

- Remove deprecated NIP-04 encryption support from NostrSigner interface.
- Remove unused getQueueSize() and getRunningCount() methods from TaskQueue.
- Replace custom base64 encoding with native btoa, using TextEncoder for UTF-8 support.
- Update docs submodule pointer.