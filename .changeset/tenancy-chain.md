---
"@dudousxd/nestjs-telescope": minor
---

The full tenancy contract of `@dudousxd/nestjs-context` 2.1, read structurally so older context versions keep working. Entries get one tenant tag per level of the active chain (`tenant:C` and `tenant:U` for unit U of clinic C), so a viewer of an organization also sees its sub-organizations' entries. The `tenancy` option takes `family` and `required`. With `required`, a console viewer with no tenant and no organizations granted by `authorize` gets the context's 403. Recording, and the console's own-tenant lookup for viewers who were granted organizations, never require one. The Organization picker labels organizations with the context's `tenancy.label`, else the slug, else the id.
