---
'@contextvm/sdk': patch
---

Payment hardening follow-ups to the transparent-payment-durability work (adversarial review findings, low-risk subset).

- **Explicit gating fails closed at capacity:** `AuthorizationStore` no longer silently LRU-evicts live pending entries — an evicted live payment disarms the dedup and a retry would mint a second invoice (the same class the transparent middleware already guards against). At capacity it purges expired entries and then refuses; the middleware answers `-32000` "Payment capacity reached, retry later" before any invoice is minted. `grant()` purges expired grants before falling back to LRU eviction, so a live unconsumed grant survives capacity pressure.
- **NWC response subscriptions no longer leak on wallet timeouts:** a `NwcClient.request()` whose response timed out (or whose publish failed) before `subscribe()` resolved left the subscription open for the process lifetime. Every failure path now releases it, including late-resolving subscriptions.
- **NWC notification subscription race fixed:** concurrent first verifications could each subscribe for `payment_received` notifications, leaking every handle but the last. The in-flight subscribe is now memoized (and retried on failure).
- **Probe-eviction blacklist lifts on reconnect:** a CEP-41 open-stream probe timeout blacklists the client pubkey until its pending response routes; if that response never routes, `sendNotification` threw forever — permanently breaking notification delivery (including `payment_required`) for a client that had re-established a session. The blacklist now lifts as soon as a live session exists again.
- **Open-stream writer reuse on duplicate delivery:** a duplicate delivery of the same request event re-entered the inbound path and overwrote the writer reservation, orphaning the writer bound to the already-forwarded request (its keepalive timers could later evict the client's session via probe timeout). The existing reservation is now reused.
- `LruCache.entries()` JSDoc corrected: iteration is least- to most-recently-used (capacity-pressure scans rely on the real order).
