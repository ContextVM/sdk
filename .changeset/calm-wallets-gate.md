---
"@contextvm/sdk": minor
---

feat: CEP-8 Explicit Payment Gating lifecycle

Add full support for the CEP-8 Explicit Gating payment interaction mode (`explicit_gating`),
enabling servers to strictly gate priced MCP capabilities behind verifiable payments before
execution.

**Protocol**

- Servers and clients negotiate `payment_interaction` mode via Nostr event tags on the first
  direct message. Servers disclose their effective mode on the first response event.
- `-32042 Payment Required`: returned with structured `payment_options` (PMI, amount, pay_req,
  description, TTL) when a priced capability is invoked without authorization.
- `-32043 Payment Pending`: returned with `retry_after` backoff when a retry races against
  active payment verification, preventing invoice-generation spam.
- `-32602 Invalid Params`: returned with `{ requested, supported }` when a client requests
  `explicit_gating` on a transparent-only server.

**Server**

- New `createExplicitGatingMiddleware` with TTL-bounded `AuthorizationStore` for single-use,
  atomic check-and-set execution grants scoped by canonical invocation identity
  (SHA-256 over JCS-canonicalized method + params + client pubkey).
- Shared `resolveAndInitiatePayment` pipeline eliminates duplication between transparent and
  explicit-gating server middlewares.
- New `PaymentInteractionPolicy` type (`'optional' | 'transparent'`) separates the server-side
  policy from the wire-level `PaymentInteractionMode`. `withServerPayments` now defaults to
  `'optional'`: a server that accepts payments advertises `explicit_gating` support and mirrors
  each client's requested lifecycle, so explicit-gating clients are gated while transparent
  clients keep the notification flow. Pass `paymentInteraction: 'transparent'` for a
  transparent-only server.

**Client**

- `withClientPayments` intercepts `-32042`/`-32043` upstream, delegates to the user's
  `onPaymentRequired` handler, and auto-retries the original request with configurable
  `maxPendingRetries` and exponential backoff.
- Effective-mode guard prevents auto-satisfying transparent payments when the server rejected
  explicit gating—synthesizes a local `-32000` decline instead.
- An inbound `payment_interaction` tag on a server response is now recorded as the session's
  effective mode only when the client itself requested `explicit_gating`. Otherwise the tag is
  treated as a server availability advertisement, preventing a transparent client from
  incorrectly believing it is on the explicit-gating lifecycle.

**Backward Compatibility**

- Wire and client compatible: legacy clients not advertising the new mode continue using the
  default `transparent` flow. Per-session middleware guards ensure explicit-gating behavior
  only activates for sessions that opted in.
- The new `'optional'` server default is a behavioral change for server operators who relied on
  the previous implicit transparent-only default: their server now also accepts
  `explicit_gating` requests from clients that ask for it. Set `paymentInteraction: 'transparent'`
  to restore transparent-only behavior.
