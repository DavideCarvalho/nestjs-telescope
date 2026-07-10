---
"@dudousxd/nestjs-telescope-cache": patch
---

`BentoCacheEmitterLike` accepts Node's generic `EventEmitter<any>` — the listener signature now mirrors Node's own (`(...args: any[]) => void`); the previous `(payload: never)` shape rejected every real emitter under strict consumers.
