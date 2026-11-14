---
'@contextvm/sdk': patch
---

Reject explicit `-32042` errors carrying more than 100 `payment_options` before validating any option, so an oversized offer cannot force validation of every element first.
