---
'@contextvm/sdk': patch
---

fix(task-queue): make shutdown async and wait for running tasks

The shutdown method now waits for running tasks to complete with a
configurable timeout instead of immediately clearing them. This provides
more graceful shutdown behavior and prevents dropping in-progress tasks.