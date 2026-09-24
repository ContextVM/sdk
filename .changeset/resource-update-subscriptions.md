---
'@contextvm/sdk': patch
---

Route `notifications/resources/updated` only to clients subscribed to the matching resource URI. Servers can configure matching for parent/sub-resource relationships. Subscriptions are recorded only when a `resources/subscribe`/`resources/unsubscribe` request is actually forwarded to the server, and a client's subscriptions are cleared as soon as authorization rejects it.
