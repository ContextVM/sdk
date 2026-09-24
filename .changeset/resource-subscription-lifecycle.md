---
'@contextvm/sdk': patch
---

Tighten the resource-subscription lifecycle on `NostrServerTransport`. `resources/subscribe`/`resources/unsubscribe` are now recorded only after the request is actually forwarded to the server, so middleware-dropped requests can no longer leave phantom subscription state behind (and a dropped unsubscribe can never re-add a subscription that never existed). A client's subscriptions are also cleared as soon as the authorization policy rejects it, so a revoked client stops receiving resource updates immediately instead of lingering until session eviction.
