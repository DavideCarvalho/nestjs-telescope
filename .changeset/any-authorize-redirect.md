---
"@dudousxd/nestjs-telescope": patch
---

`anyAuthorize` keeps a `redirectTo` from any form. Before, when an earlier form answered `unauthenticated` without one (a guest with no token, in `anyAuthorize(authorizeByToken(...), SessionAuthorizer)`), the console answered a bare 401 and ignored a later form's redirect to the sign-in page.
