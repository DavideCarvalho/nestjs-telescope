import type { DynamicModule } from '@nestjs/common';

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
   * Class decorators applied to the dashboard's page + asset controller
   * (`TelescopeUiController`), the same shape as `@nestjs/mcp`'s `decorators`,
   * e.g. `[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` with
   * `@nestjs/authentication` + `@nestjs/authorization`. Pass the same list to
   * `TelescopeModule.forRoot({ decorators })` (core) so the API matches. Full-page
   * navigations carry cookies, not an `Authorization` header, so the
   * authentication strategy here must read a cookie session.
   *
   * PRODUCTION RULE: with `NODE_ENV === 'production'`, mounting the page with no
   * `decorators` (an empty array counts as none) fails the boot; protect it with
   * `decorators` or mount it yourself with {@link routes}`: false`. Outside
   * production an undecorated page mounts open.
   *
   * The controller is also marked open to `@nestjs/authorization`'s
   * deny-by-default global `AuthorizationGuard` (as `@Can.Anyone()` would), so an
   * undecorated dev page keeps loading when that package is adopted. A
   * `Can(...)` passed here is still enforced. Applied to a fresh subclass per
   * registration, so nothing leaks between `forRoot` calls. With `forRootAsync`,
   * pass it as the static top-level option.
   */
  decorators?: ClassDecorator[];
  /**
   * `false` mounts NO controller; serve the page from a controller of your own
   * by extending the exported `TelescopeUiController` (its `TELESCOPE_UI_OPTIONS`
   * dependency is exported by the module), protected with ordinary Nest
   * decorators. The base class carries no guard, so yours are the whole gate:
   *
   * ```ts
   * @Controller('ops/telescope')
   * @Can(ConsolePolicy, 'view')
   * class ConsolePage extends TelescopeUiController {}
   * ```
   *
   * Named `routes`, not `path: false`, because `path` keeps a job without
   * routes: the page rewrites its asset URLs against it, so set it to where you
   * mount the controller (and to core's `path`). `decorators` only applies to
   * the mounted controller and is ignored here. With `forRootAsync`, pass it as
   * the static top-level `routes`. Default `true`.
   */
  routes?: boolean;
  /**
   * Extra `imports` merged into `TelescopeUiModule`'s own dynamic module — the
   * DI resolution path for whatever the {@link decorators} need.
   */
  imports?: DynamicModule['imports'];
}
