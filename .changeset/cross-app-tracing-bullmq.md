---
'@dudousxd/nestjs-telescope-bullmq': minor
---

With a core that has tracing across apps (`propagation`), a job added inside a trace carries it in its own `opts.telemetry.metadata` and the worker runs it in that trace, in whichever app it lives; the job entry names the dispatching span (`content.parentSpanId`). A queue with BullMQ `telemetry`, or a job that already carries a trace, is left alone. Inert with an older core.
