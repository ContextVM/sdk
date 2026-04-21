---
"@contextvm/sdk": patch
---

fix(transport): make discoverability relay publication deterministic for local and memory relay environments.

- Skip default bootstrap relays when operational relays are local/memory and no explicit bootstrap list is configured.
- Fallback to direct publish when discoverability targets are non-websocket relay URLs.
- Stabilize oversized transfer event assertions and add focused announcement manager coverage for relay target selection.
