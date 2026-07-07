---
'@contextvm/sdk': patch
---

feat(payments): renegotiable `payment_interaction` (mid-session upsert + reset-on-initialize)

A client's `payment_interaction` mode was previously latched for the entire
server-side session lifetime (LRU eviction / restart). Once a pubkey negotiated
`explicit_gating`, it could not downgrade to `transparent` — a reconnect
requesting a different mode was silently ignored and priced tools kept
returning `-32042`. This was an underspecified session-boundary gap between
CEP-8 and CEP-35.

The server now treats `payment_interaction` as an updatable session preference
(aligned with the CEP-8 "Mid-session payment-interaction update" amendment):

- **Mid-session upsert**: a `payment_interaction` tag on any direct
  client→server message (not only the first) updates the session's effective
  mode; an absent tag inherits the current effective mode. The effective mode is
  re-disclosed on the next response only when it actually changes.
- **Reset-on-initialize**: a fresh `initialize` request resets the session's
  negotiated payment state (CEP-35 local policy), so stateful clients that omit
  the tag on reconnect (older clients, or clients that omit the option)
  downgrade to the transparent default instead of staying latched.

Client side: `NostrClientTransport` / `withClientPayments` now advertises
`payment_interaction=transparent` (not only `explicit_gating`), so a downgrade
intent is distinguishable from "no preference." `setPaymentInteraction(mode)`
resets the send latch when the mode changes, so the tag is re-emitted on the
next outbound request (transport-level mid-session upsert).

The transparent and explicit-gating lifecycles use disjoint correlation stores
by design, so a paid authorization under one lifecycle is not consumed by a
request handled under the other after a mode flip.
