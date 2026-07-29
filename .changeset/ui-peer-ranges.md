---
'@dudousxd/nestjs-telescope-ui': patch
---

Bound the React peer ranges to the majors this package is actually built and tested against.

`react` and `react-dom` were declared `>=18.0.0` and `@tanstack/react-query` `>=5.0.0` — open-ended
ranges that claim support for every future major. React 20 and Query 6 do not exist yet and
certainly are not tested here, so the declaration was a promise the package cannot keep; a consumer
on a future major would get no warning and a runtime surprise instead.

Now `^18.0.0 || ^19.0.0` and `^5.0.0`. Both majors are real: the package builds and tests against
React 18, and its `./react/console` launcher is consumed from a React 19 host.

No behaviour change — peer ranges only affect what a package manager warns about on install.
