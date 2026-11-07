import type { DashboardAuthOptions } from '@dudousxd/nestjs-telescope';
import type { CanActivate, DynamicModule, Type } from '@nestjs/common';

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
   * Guard classes (or already-instantiated `CanActivate`s) fronting the
   * dashboard's page + static-asset controller (`TelescopeUiController`) — the
   * full-page HTML shell and its hashed JS/CSS bundle. See
   * `TelescopeModuleOptions.guards` (`@dudousxd/nestjs-telescope`) for the full
   * rationale: full-page navigations carry no `Authorization` header, so a
   * header-only auth scheme can't gate this controller — a guard here must be
   * able to authenticate from a COOKIE (falling back to a header for XHR/fetch
   * callers if useful). See the "Securing the console" guide.
   *
   * These two `guards` options are INDEPENDENT — different package, different
   * module — so pass the SAME `guards` (and matching `imports`) to BOTH
   * `TelescopeModule.forRoot` (core) and this module. Setting it here alone
   * still leaves the API reachable; setting it only on core still leaves the
   * page itself (HTML shell + assets) reachable by an anonymous browser.
   *
   * Unlike core's console API controllers, `TelescopeUiController` ships with
   * NO guard of its own by default (the page + assets are considered public —
   * no data lives there), so setting `guards` here is a plain REPLACE: the
   * listed guard(s) become the controller's entire gate.
   */
  guards?: Array<Type<CanActivate> | CanActivate>;
  /**
   * Class decorators applied to the dashboard's page + asset controller
   * (`TelescopeUiController`), the same shape as `@nestjs/mcp`'s `decorators`,
   * e.g. `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` with
   * `@nestjs/authentication` + `@nestjs/authorization`. Pass the same list to
   * `TelescopeModule.forRoot({ decorators })` (core) so the API matches.
   *
   * DEFAULT: the controller is marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so
   * the page keeps loading when that package is adopted; {@link guards} keeps
   * deciding who reaches it. A `Can(...)` passed here is still enforced.
   * Applied to a fresh subclass per registration, so nothing leaks between
   * `forRoot` calls. With `forRootAsync`, pass it as the static top-level option.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts NO controller; serve the page from a controller of your own
   * by extending the exported `TelescopeUiController` (its `TELESCOPE_UI_OPTIONS`
   * dependency is exported by the module), protected with ordinary Nest
   * decorators:
   *
   * ```ts
   * @Controller('ops/telescope')
   * @Can(ConsolePolicy, 'view')
   * class ConsolePage extends TelescopeUiController {}
   * ```
   *
   * Named `routes`, not `path: false`, because `path` keeps a job without
   * routes: the page rewrites its asset URLs against it, so set it to where you
   * mount the controller (and to core's `path`). `guards` and `decorators` only
   * apply to the mounted controller and are ignored here. With `forRootAsync`,
   * pass it as the static top-level `routes`. Default `true`.
   */
  routes?: boolean;
  /**
   * The SAME `dashboardAuth` passed to `TelescopeModule.forRoot` (core). Only needed to use
   * `dashboardAuth.unauthenticatedPage`: this module serves the page + SPA shell, so it is the only
   * one that can replace that page — core gates the API, not the HTML.
   *
   * Like {@link guards}, the two options are INDEPENDENT (different package, different module).
   * Setting `unauthenticatedPage` only on core gates the API but leaves the page untouched, and the
   * visitor keeps getting the SPA's built-in auth screen.
   *
   * Everything except `secret`, the configured modes, and `unauthenticatedPage` is ignored here —
   * minting and renewal stay entirely core's job. The full options type is accepted so a host can
   * pass one object to both modules rather than hand-picking fields.
   */
  dashboardAuth?: DashboardAuthOptions;
  /**
   * Extra `imports` merged into `TelescopeUiModule`'s own dynamic module — the
   * DI resolution path for a class passed to {@link guards}.
   */
  imports?: DynamicModule['imports'];
}
