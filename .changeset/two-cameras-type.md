---
'@contextvm/sdk': patch
---

fix(transport): add client-side event deduplication and improve open-stream error handling

- Add duplicate detection for plain inbound events in nostr-client event pipeline to prevent reprocessing
- Move lastChunkIndex validation earlier in close frame processing to reject malformed frames before marking stream closed
- Ensure writer lifecycle callbacks (onClose, onAbort) run even when frame publish fails
- Add tests for client deduplication, malformed close validation, and writer failure scenarios
