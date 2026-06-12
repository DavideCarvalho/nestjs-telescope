---
"@dudousxd/nestjs-telescope-ui": patch
---

Add a **Workflows** nav tab for durable-workflow entries. The dashboard now knows the `durable`
entry type (recorded by `@dudousxd/nestjs-durable-telescope`'s watcher), so when a host registers
that watcher the sidebar shows a "Workflows" tab listing every workflow run/step lifecycle event,
tagged by `workflow:<name>` / `kind:<local|remote|sleep|signal>`. Without the watcher registered the
tab stays hidden, like every other watcher-driven nav item.
