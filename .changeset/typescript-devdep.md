---
'@contextvm/sdk': patch
---

Move `typescript` from `peerDependencies` to `devDependencies`. The package ships pre-compiled `dist` (`.js` + `.d.ts`) and consumers never compile its sources, so `typescript` is a build-time concern, not a peer requirement. The peer range was emitting unmet-peer warnings for consumers on TS versions outside `^5.9.3` (e.g. TS 6.x) with no functional effect.
