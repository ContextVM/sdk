---
'@contextvm/sdk': patch
---

`NostrClientTransport` now exposes `getOperationalRelayUrls()`, returning the current handler's relay URLs: configured URLs before `start()`, and the final set after relay resolution (server-identity hints, kind-10002 discovery, fallback probe) once `start()` resolves. Callers can read the resolved set once and persist it, so future sessions construct a plain configured client without re-paying discovery.
