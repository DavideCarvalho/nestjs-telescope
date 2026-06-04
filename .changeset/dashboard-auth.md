---
'@dudousxd/nestjs-telescope': minor
---

Add `dashboardAuth` — a cookie-session gate for the Telescope dashboard.

Hosts can now require a signed, same-origin session cookie for every dashboard
API call, all the way to prod, with no infra (no oauth2-proxy/ingress). A
generic SPA can't send a host's Bearer header on navigations, but a path-scoped
cookie rides along automatically — so this gates the dashboard without breaking
its client.

Two modes mint the same stateless HMAC-SHA256 cookie (`node:crypto` only, no JWT
dependency):

- **`session`** (seamless): the host frontend POSTs `/<path>/api/auth/session`
  carrying its own auth; a host hook validates the raw request and returns the
  session user.
- **`login`** (universal): a built-in login form POSTs `/<path>/api/auth/login`;
  a host hook validates the credentials.

```ts
TelescopeModule.forRoot({
  dashboardAuth: {
    secret: process.env.TELESCOPE_AUTH_SECRET,
    ttl: '8h', // sliding renewal past 50% of the TTL
    login: (u, p) => (u === env.USER && p === env.PASS ? { id: 'ops' } : null),
  },
});
```

When configured, `TelescopeGuard` requires a valid cookie on every `/api/*`
route except `/api/auth/*`, attaches the session as `request.telescopeSession`
(readable by `authorizer` / `authorizeAction`), and still ANDs the existing
`authorizer`. `meta` gains `auth: { enabled, modes }`. A missing/empty `secret`
or no hook is a boot error (fail closed). When unset, behavior is unchanged.
