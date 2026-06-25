---
"@dudousxd/nestjs-telescope": minor
---

Add a startup grace to the overload guard so the synchronous bootstrap stall (DI wiring, migrations, codegen blocking the event loop) no longer trips overload protection on a transient. The guard now discards its first measurement windows after arming and only judges live load once the loop settles.

Configurable via `overloadProtection.startupGraceMs` (default ~5000ms; set `0` to arm immediately).
