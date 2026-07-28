---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

**`dashboardAuth.unauthenticatedPage` — hosts can now render the dashboard's unauthenticated page themselves.**

Under Mode A, a visitor navigating straight to `/telescope` with no cookie got the SPA shell, which
then rendered the built-in auth screen: *"open this console from your application."* Deliberately
generic, because the library cannot know who hosts it — it can't name the host's launcher, link to
it, or look like the rest of the host's product.

```ts
const dashboardAuth = {
  secret: process.env.TELESCOPE_AUTH_SECRET,
  session: (request) => resolveAdmin(request),
  unauthenticatedPage: ({ request, response, basePath }) => {
    (response as Response).status(401).render('console-locked', { returnTo: basePath });
  },
};

TelescopeModule.forRoot({ enabled: true, dashboardAuth });
TelescopeUiModule.forRoot({ dashboardAuth }); // <- also here; see below
```

Telescope's auth screen is a React component inside the published bundle — there is no
server-rendered page to replace. So the hook gates the **SPA shell route**: the session is checked
before the shell is served, which also means the bundle no longer loads at all for a visitor with no
session. Hashed assets stay ungated; they carry no data.

**`TelescopeUiModule` gains a `dashboardAuth` option, and it must be given the same config.**
`TelescopeModule` (core) gates the JSON API; `TelescopeUiModule` serves the HTML, so it is the only
one that can replace that page — the same independence the two modules' `guards` options already
have. Setting `unauthenticatedPage` on core alone changes nothing a visitor sees. Only `secret`, the
configured modes and `unauthenticatedPage` are read there; minting and renewal stay core's job.

**Mode-A-only by design.** With `login` configured the hook is ignored: under Mode B the login form
the visitor needs is *inside* the bundle this page would replace, so gating the shell would lock a
Mode B host out of its own dashboard.

Fail-closed by construction: it only runs when the request carries no valid session cookie (a cookie
signed with another secret does not count), and every data route stays behind `TelescopeGuard`
regardless. A hook that throws, or returns without writing, logs one warning and serves the SPA
rather than hanging the request or turning a navigation into a `500`.

The UI shell route became non-passthrough `@Res()` so the host can own the response; its
`Content-Type`/`Cache-Control` moved from decorators into a new `sendHtml` helper, unchanged. Core
additionally exports `sendHtml` / `responseAlreadyWritten`.

Fully backward compatible — omit the option and the shell is served exactly as before, with no
session check on that route at all.
