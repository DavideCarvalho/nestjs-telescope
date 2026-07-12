---
'@dudousxd/nestjs-telescope': minor
---

`RecordInput.traceId` — integrations that already know their trace correlation (e.g. a diagnostics
span envelope whose traceId is the originating run's id) can state it explicitly; it wins over the
ambient OTel/context-accessor stamping, which remains the default when absent. This is what lets
lib-emitted spans land on the Entry column `TracesService.getWaterfall(traceId)` queries — the
missing half of rendering non-OTel span pipelines in the TRACES tab.
