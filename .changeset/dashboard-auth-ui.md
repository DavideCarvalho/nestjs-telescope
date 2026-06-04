---
'@dudousxd/nestjs-telescope-ui': minor
---

Gate the dashboard SPA behind `dashboardAuth` when the host enables it.

On boot the SPA calls `GET /auth/me` and branches three ways:

- **disabled** (auth not configured → `404`): renders the dashboard exactly as
  before, with no auth UI.
- **authenticated** (`200`): renders the dashboard plus a **Sign out** button in
  the header (next to the theme/live-tail toggles).
- **unauthenticated** (`401`): renders an **AuthScreen** chosen from the modes in
  the `401` body — a username/password **Sign in** form (`login` mode, inline
  "Invalid credentials" on failure) or an "Open Telescope from your application"
  instruction card with a **Retry** button (`session`-only mode).

A `401` from any API call mid-session (expired cookie) flips the app back to the
AuthScreen automatically. The client gains `auth.me()`/`auth.login()`/
`auth.logout()`; cookies ride along on the existing same-origin `fetch`, so
there are no transport changes. With `dashboardAuth` unset, behavior is
unchanged.
