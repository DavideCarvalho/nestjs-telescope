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
}
