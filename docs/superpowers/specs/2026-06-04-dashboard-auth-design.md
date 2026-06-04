# Telescope Dashboard Auth — design

**Goal (Davi, 2026-06-04):** any host app can gate the Telescope dashboard so only
its logged-in admins see it — all the way to prod. No infra required (no
oauth2-proxy/ingress), easy for any community user to adopt.

**The core problem this solves:** hosts commonly use header-Bearer auth (e.g.
flip's Keycloak JWT). The generic dashboard SPA can't send that header on browser
navigations/fetches, so `authorizer` alone can't gate the dashboard without
breaking it. Cookies CAN ride along automatically: the UI client already uses
`fetch` with default `credentials: same-origin`, so a same-origin, path-scoped
cookie reaches every SPA call with **zero UI-client changes**.

## Decision summary (approved in brainstorm)
- **Two modes, one mechanism.** Both mint the same signed cookie:
  - **Mode A — `session` (seamless):** the host's own frontend (which holds the
    host's auth) calls `POST /telescope/api/auth/session` with that auth; a host
    hook validates it and returns the session user. No second login.
  - **Mode B — `login` (universal):** Telescope ships a built-in login screen;
    a host hook validates the credentials. Zero host-frontend changes.
- **Stateless signed cookie (HMAC).** No store, no revocation list — short TTL +
  sliding renewal. (Server-side revocable sessions = future option, YAGNI now.)
- Hosts may enable either mode or both.

## Config surface (core `TelescopeModuleOptions`)
```ts
TelescopeModule.forRoot({
  dashboardAuth: {
    /** REQUIRED. HMAC-SHA256 signing key (32+ bytes recommended). Missing/empty
     *  while dashboardAuth is set => boot error (fail closed). */
    secret: process.env.TELESCOPE_AUTH_SECRET,
    /** Cookie TTL (duration string, reuses durationToMs). Default '8h'. Sliding
     *  renewal: a valid cookie past 50% of its TTL is transparently re-issued. */
    ttl: '8h',
    /** Mode A. Called by POST /auth/session with the RAW request — the host
     *  validates its own auth (e.g. verify the Bearer JWT, check role) and
     *  returns the session user, or null to deny. */
    session?: (request: unknown) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null,
    /** Mode B. Called by POST /auth/login with the submitted credentials. */
    login?: (username: string, password: string) => Promise<TelescopeSessionUser | null> | TelescopeSessionUser | null,
  },
})

interface TelescopeSessionUser {
  id: string;
  name?: string;
  /** Free-form role strings; the lib does NOT interpret them. Hooks decide who
   *  gets in; authorizeAction can read them for mutation gating. */
  roles?: string[];
}
```
At least one of `session`/`login` is required when `dashboardAuth` is set
(boot error otherwise). When `dashboardAuth` is NOT set, behavior is unchanged
(existing `authorizer` / default deny-in-prod).

## Cookie
- Name `telescope_session`; `httpOnly`, `SameSite=Lax`, `Secure` when the request
  is https (or `x-forwarded-proto: https`), `Path=/<mount path>` (respects the
  configurable `path`, default `/telescope`).
- Value: `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload, secret))`
  with payload `{ sub, name?, roles, iat, exp }`. Verified with
  `crypto.timingSafeEqual`. **No JWT dependency** — `node:crypto` only.
- Tampered / expired / malformed => treated as absent (401), never throws.
- Sliding renewal handled centrally in the guard: on a valid cookie older than
  50% of TTL, set a fresh cookie on the response.

## Endpoints (core controller, under `/<path>/api/auth/*`)
| Endpoint | Mode | Behavior |
|---|---|---|
| `POST /auth/session` | A | Runs `session(request)`. User => set cookie, `204`. Null => `401`. `404` when mode A not configured. |
| `POST /auth/login` | B | Body `{username, password}` (validated shape). Runs `login(...)`. User => set cookie, `204`. Null => `401` (uniform message — no user-enumeration). `404` when mode B not configured. |
| `POST /auth/logout` | both | Clears the cookie. `204`. |
| `GET /auth/me` | both | Valid cookie => `200 { user: {id, name, roles} }`. Else `401` with body `{ auth: { modes: ('session'\|'login')[] } }` — the unauthenticated SPA learns which AuthScreen to render from this body (NOT from `/api/meta`, which stays behind the gate). |

`/auth/*` endpoints are NOT behind the session gate (they create it). They ARE
rate-limit-friendly (no heavy work before hook); brute-force throttling on
`/auth/login` is documented as the host's job (Nest Throttler etc.).

## Gate behavior
When `dashboardAuth` is configured:
- `TelescopeGuard` requires a valid session cookie for every `/api/*` route
  (except `/api/auth/*`). The parsed session is attached to the request as
  `request.telescopeSession` so `authorizer` / `authorizeAction` hooks can read
  the user + roles.
- The existing `authorizer` hook still runs AFTER the session check (AND
  semantics — optional extra restriction). Default prod-deny is replaced by the
  session gate when `dashboardAuth` is present.
- **UI shell + hashed assets stay public** — they contain no data. The SPA boots,
  calls `/auth/me`, and on `401` renders the auth screen instead of the app.
- Mutations: `authorizeAction` unchanged (separate, default-deny). With sessions
  it can now do role checks: `({request}) => request.telescopeSession?.roles?.includes('admin')`.
- CSRF: `SameSite=Lax` blocks cross-site POSTs with the cookie; queue mutations
  are POSTs => covered. Documented in README's security section.

## UI (`-ui` package)
- `meta` gains `auth: { enabled: boolean, modes: ('session'|'login')[] }` for the
  AUTHENTICATED state (e.g. showing the logout button); the UNauthenticated SPA
  learns the modes from the `401` body of `GET /auth/me` (meta stays gated).
- New **AuthScreen** rendered when `/auth/me` is 401:
  - mode includes `login` => username/password form posting to `/auth/login`
    (error state on 401; loading state).
  - mode is `session`-only => instruction screen: "Open Telescope from your
    app" (the host's button mints the session) + a Retry button.
- **Logout** button in the shell header (visible when authenticated; calls
  `/auth/logout`, returns to AuthScreen).
- Client: `auth.me()/login()/logout()` methods; a 401 from any API call flips
  the app to the AuthScreen (session expired mid-use).
- No transport changes: cookies already flow (`credentials: same-origin`).

## Host adoption (README — both recipes, copy-pasteable)
- **Mode B (easiest):** `dashboardAuth: { secret, login: (u,p) => u === env.USER && p === env.PASS ? {id:'ops'} : null }` — gates the dashboard in 5 lines, works to prod.
- **Mode A (flip-style):** host hook verifies its own Bearer (`session: async (req) => { const user = await myAuth.verify(req); return user?.isAdmin ? {id user.id, roles:['admin']} : null }`) + an "Open Telescope" button in the host frontend:
  `await fetch('/telescope/api/auth/session', {method:'POST', headers:{Authorization: 'Bearer '+token}}); window.open('/telescope')`.

## flip wiring (follow-up, after the lib feature ships)
- `TELESCOPE_AUTH_SECRET` via External Secrets; `session` hook = verify Bearer via
  flip's `AuthTokenService` + require role ADMIN; "Open Telescope" entry in the
  admin UI. Replaces the interim ideas (basic-auth / `() => true`). Then the
  dev-deploy plan proceeds (clean branch off master, OTel off, prune 1h, no SQS
  manager, npm deps 1.0.0).

## Error handling
- Hook throws => treated as null (deny) + warn-log once per kind; never 500s the
  auth endpoint into a stack leak.
- Missing/short secret at boot => hard error with a clear message.
- Clock skew: `exp` checked with a 30s grace.

## Testing
- Cookie codec: sign/verify round-trip, tamper (payload + sig), expiry, grace,
  malformed input never throws.
- Guard: 401 without/with-invalid cookie; allow + `request.telescopeSession`
  attached; sliding renewal sets a fresh cookie; `/auth/*` reachable ungated;
  authorizer still ANDs.
- Endpoints: both modes (hook returning user/null/throwing), 404 when mode not
  configured, logout clears, `me` shape.
- UI: AuthScreen per mode, login error state, logout flow, 401-mid-session flip.
- E2E (Express + Fastify, matching the lib's existing e2e pattern): full
  login => cookie => API allowed => logout => 401.

## Out of scope (explicit)
- Server-side/revocable sessions (future; design allows swapping the codec).
- OAuth/OIDC flows inside Telescope (hosts bridge via Mode A).
- Per-view authorization granularity (single all-or-nothing dashboard session +
  the existing authorizeAction for mutations).
