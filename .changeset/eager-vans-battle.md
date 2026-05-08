---
'@contextvm/sdk': patch
---

fix(transport): ensure session cleanup and proper ordering in open streams

- Fix registry to remove sessions even when onClose/onAbort callbacks throw
- Add queuedBytes tracking to count unread chunks against buffer limits
- Release queued byte budget when chunks are consumed by iterator
- Add operation queue to writer to serialize concurrent writes before close
- Add tests for concurrent chunk/close processing and callback error handling