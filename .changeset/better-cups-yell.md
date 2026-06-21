---
'@contextvm/sdk': patch
---

fix: use req() to avoid dedup deadlock after applesauce-relay 6.0.3

The applesauce-relay 6.0.3 upgrade changed `RelayGroup.subscription()` to emit
only deduplicated NostrEvents and removed EOSE markers. This broke our explicit-
gating payment flow, which re-sends identical request event IDs after payment and
relies on the server re-observing them. Relay-layer dedup would swallow the retry
and deadlock the flow.

Switch to subscribing to the raw `RelayGroup.req()` message stream (EVENT/EOSE)
to preserve the previous behavior:
- Forward every event without deduplication (dedup is handled at the transport
  layer with protocol-aware semantics).
- Restore EOSE callbacks for accurate completion tracking.

Also update tests to match the new implementation and remove the `eoseTimeout`
test (no longer supported in applesauce-relay 6.0.3).