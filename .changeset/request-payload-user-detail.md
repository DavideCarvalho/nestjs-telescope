---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Capture richer request detail. The request middleware now records the parsed
request body as `payload` and the authenticated user as the new
`RequestContent.user` field — read in the `res.on('finish')` callback (after the
host body-parser and guards have run). The user defaults to the raw request's
`user` (the Passport/guard convention) and is customizable via the new
`TelescopeModuleOptions.resolveUser(request)` hook. Both flow through the
Recorder's redaction (passwords/tokens masked). The request detail UI gains
collapsible Headers (with count), a pretty-printed Payload section, and a User
section ("anonymous" when none).
