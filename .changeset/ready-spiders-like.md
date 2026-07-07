---
'@contextvm/sdk': patch
---

feat(gateway): add optional CEP-8 payment gating support

The NostrMCPGateway now accepts an optional `paymentOptions` field in its
options. When provided, the internal NostrServerTransport is wrapped with
`withServerPayments` to enable CEP-8 payment gating, capability advertisement,
and payment interaction negotiation. This mirrors the client-side
`withClientPayments` in NostrMCPProxy. Omitting the option keeps the server
free (non-gated).