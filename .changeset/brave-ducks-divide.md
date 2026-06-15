---
'@contextvm/sdk': patch
---

fix: forward progress notifications for oversized transfer timeout

Forward progress notifications before processing oversized frames so that
resetTimeoutOnProgress works (CEP-22 timeout semantics). Also fix e2e tests
to filter only result responses, preventing progress notifications from
being incorrectly captured as responses.