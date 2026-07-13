---
'@dudousxd/nestjs-telescope': patch
'@dudousxd/nestjs-telescope-ui': patch
---

Docs + regression tests confirming `dashboardAuth`'s `login` hook already receives the submitted password verbatim end-to-end — including an empty string, since the built-in login screen never marks the field `required` and the auth controller only checks it's a string, not a non-empty one. No code path was blocking empty passwords; this closes the gap for hosts whose `login` hook gates on username alone (e.g. email must be an active admin) and deliberately ignores the password. Documented the pass-through in the `dashboardAuth` reference and added tests asserting: the hook is called with `''`, a hook rejecting an empty password still uniform-fails with `401`, and a hook accepting one mints the session.
