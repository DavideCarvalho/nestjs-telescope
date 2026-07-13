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
   * Extra `imports` merged into `TelescopeUiModule`'s own dynamic module — the
   * DI resolution path for a class passed to {@link guards}.
   */
  imports?: DynamicModule['imports'];
}
