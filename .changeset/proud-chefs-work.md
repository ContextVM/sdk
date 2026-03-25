---
'@contextvm/sdk': patch
---

feat(transport): add dynamic pubkey and capability exclusion authorization

Add support for dynamic authorization in NostrServerTransport through two new optional callbacks: isPubkeyAllowed for runtime pubkey validation and isCapabilityExcluded for dynamic capability exclusion. These async callbacks complement the existing static allowlist and exclusion configurations, enabling more flexible authorization policies. The authorization policy methods have been made async to support these new dynamic checks.