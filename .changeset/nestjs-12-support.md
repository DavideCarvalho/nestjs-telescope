---
'@dudousxd/nestjs-telescope': patch
'@dudousxd/nestjs-telescope-bullmq': patch
'@dudousxd/nestjs-telescope-cache': patch
'@dudousxd/nestjs-telescope-events': patch
'@dudousxd/nestjs-telescope-logs': patch
'@dudousxd/nestjs-telescope-mikro-orm': patch
'@dudousxd/nestjs-telescope-mikro-orm-watcher': patch
'@dudousxd/nestjs-telescope-otel': patch
'@dudousxd/nestjs-telescope-schedule': patch
'@dudousxd/nestjs-telescope-sqs': patch
'@dudousxd/nestjs-telescope-ui': patch
---

Add NestJS 12 to the supported peer range.

NestJS 12.0.1 shipped the framework as pure ESM and raised its floor to Node >= 20.19. Telescope's
packages are already `"type": "module"`, so the ESM shift is a non-event here — nothing needed
porting, and every watcher, storage provider and dashboard route behaves identically on 11 and 12.

The declared peer ranges (`@nestjs/common`/`@nestjs/core` at `>=10.0.0`, `>=11.0.0` for the UI
package, and the satellite peers `@nestjs/bullmq`, `@nestjs/cache-manager`, `@nestjs/event-emitter`,
`@nestjs/schedule`) already admitted a 12.x resolution, so no range changed — what changed is that
the claim is now tested. Every package's dev and test matrix moved to the 12.x line, along with the
example app and the memory-soak harness, and the whole suite builds, typechecks and passes there.

Moving the example app and the soak harness matters for more than tidiness: leaving them on
`@nestjs/platform-express@11` left a second `@nestjs/platform-express` major in the workspace, and
pnpm's peer resolution then produced two distinct `@nestjs/core@12` instances. `tsc` correctly
rejected the resulting `ModuleRef` from one instance where the other was expected. That is a
workspace resolution artifact rather than a NestJS 12 incompatibility, but it is exactly the shape
of breakage a consumer sees when they upgrade half a dependency graph.

No behaviour change — peer ranges only affect what a package manager warns about on install.
