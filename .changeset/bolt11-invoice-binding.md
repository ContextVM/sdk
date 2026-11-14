---
'@contextvm/sdk': patch
---

Bind BOLT11 invoices to the offered amount before any wallet or issuer side effect.

`LnBolt11NwcPaymentHandler` and `LnBolt11LnbitsPaymentHandler` now decline, through `canHandle` and again in `handle`, invoices that are malformed, amountless, expired, or whose encoded amount differs from the offer's `amount` in sats. Previously only the advertised `amount` was checked against client limits while the wallet paid the invoice's encoded amount. An optional `network` option also refuses invoices for another network.

The NWC, LNbits, and zap processors refuse a provider-issued invoice that does not encode the quoted amount or has already expired, instead of advertising it. This matters most for zaps, where the invoice comes from a remote LNURL service.
