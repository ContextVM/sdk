---
'@contextvm/sdk': patch
---

Fix `OpenStreamSession` aborting an acknowledged stream when a keepalive ping's publication rejects late: if a matching pong already reconciled the probe (or a newer probe superseded it), the late publication error is now ignored. Streams with proven liveness survive relay acknowledgement failures that resolve after the pong; probes that are still unacknowledged abort exactly as before.
