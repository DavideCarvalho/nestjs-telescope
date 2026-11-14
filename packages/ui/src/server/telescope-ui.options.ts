import type { ConsoleAuthorize } from '@dudousxd/nestjs-telescope';
import type { DynamicModule } from '@nestjs/common';
import type { ConsoleSignOutOption, ConsoleViewerResolver } from './console-shell.js';

export const TELESCOPE_UI_OPTIONS = Symbol('TELESCOPE_UI_OPTIONS');

export interface TelescopeUiModuleOptions {
  /** Directory of the built SPA (index.html + assets/). Defaults to the bundled dist/spa. */
  assetsDir?: string;
  /**
   * Mount path for the dashboard (no leading/trailing slash needed). Defaults to
   * `'telescope'` — when unset the dashboard lives at `/telescope` exactly as
   * before. Must match the core `TelescopeModule.forRoot({ path })`.
   */
  path?: string;
  /**
   * Who may open the dashboard page and its assets. The same contract (and
   * usually the same value) as `TelescopeModule.forRoot({ authorize })`:
   * a function, an `@Injectable()` class implementing `ConsoleAuthorizer`, a
   * lazy `() => import(...)`, `{ policy, ability }` for `@nestjs/authorization`,
   * a gate name from `@dudousxd/nestjs-authz`, or `authorizeByToken(...)`.
   *
   * A denied browser navigation gets an "Access denied" page (403), a "Sign in
   * required" page (401), or a 302 to `redirectTo` when the check returns
   * `{ redirectTo: '/login' }`. Page
   * navigations carry cookies, not an `Authorization` header, so check a
   * session here rather than a token.
   *
   * Omitted: open outside production; with `NODE_ENV === 'production'` every
   * request answers 403, and one warning is logged at boot. With
   * `forRootAsync` it can come from the factory.
   */
  authorize?: ConsoleAuthorize;
  /**
   * Class decorators applied to the dashboard's page + asset controller
   * (`TelescopeUiController`), the same shape as `@nestjs/mcp`'s `decorators`,
   * e.g. `[UseGuards(AuthenticationGuard)]` so `request.user` is set before
   * {@link authorize} runs. Decorators alone do not configure access: without
   * `authorize` the page still answers 403 in production.
   *
   * The controller is also marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so
   * that guard does not lock the page out; `authorize` decides. A `Can(...)`
   * passed here is still enforced. Applied to a fresh subclass per
   * registration, so nothing leaks between `forRoot` calls. With `forRootAsync`,
   * pass it as the static top-level option.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts NO controller; serve the page from a controller of your own
   * by extending the exported `TelescopeUiController` (its `TELESCOPE_UI_OPTIONS`
   * dependency is exported by the module), protected with
   * `@UseConsoleAuthorize()`. With no argument it runs
   * `TelescopeModule.forRoot({ authorize })`; pass `{ authorize }` for a
   * different check. List it ABOVE your authentication guard, so that guard
   * runs first and sets `request.user`:
   *
   * ```ts
   * @Controller('ops/telescope')
   * @UseConsoleAuthorize()
   * @UseGuards(AuthGuard)
   * class ConsolePage extends TelescopeUiController {}
   * ```
   *
   * Named `routes`, not `path: false`, because `path` keeps a job without
   * routes: the page rewrites its asset URLs against it, so set it to where you
   * mount the controller (and to core's `path`). `decorators` and `authorize`
   * only apply to the mounted controller and are ignored here. With `forRootAsync`, pass it as
   * the static top-level `routes`. Default `true`.
   */
  routes?: boolean;
  /**
   * Extra `imports` merged into `TelescopeUiModule`'s own dynamic module — the
   * DI resolution path for whatever the {@link decorators} need.
   */
  imports?: DynamicModule['imports'];
  /**
   * Who the console's sidebar footer says is signed in: `(request) => ({ label, email?, role? })`,
   * sync or async. `null`/`undefined` or a throw shows no user row.
   *
   * Omitted: `request.user` is read structurally — whatever your guards ({@link decorators})
   * already put there: `fullName` → `name` → `email` for the label, and `role` or the first of
   * `roles` (a string or `{ name }`). Reading it never triggers an authentication. With
   * `forRootAsync` it can come from the factory.
   */
  viewer?: ConsoleViewerResolver;
  /**
   * The sidebar footer's sign-out. One of:
   *
   * - `'/logout'`: a POST form to that path (with `_csrf` when the request exposes
   *   `req.csrfToken()`);
   * - `{ href: '/logout' }`: a plain link;
   * - `{ action: '/logout', csrfToken: (request) => token }`: a POST form with your token as `_csrf`;
   * - `false`: none, even when an account console announced one.
   *
   * Omitted: the sign-out an account console announced on the Aviary consoles registry
   * (`account.signOut`), else none. Only same-origin paths (`/x`) are ever sent to the page. With
   * `forRootAsync` it can come from the factory.
   */
  signOut?: ConsoleSignOutOption;
}
