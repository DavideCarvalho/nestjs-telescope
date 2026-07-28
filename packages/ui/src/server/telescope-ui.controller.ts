import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ResolvedDashboardAuth,
  SESSION_COOKIE_NAME,
  normalizeTelescopePath,
  parseCookieHeader,
  readCookieHeader,
  resolveDashboardAuth,
  responseAlreadyWritten,
  sendHtml,
  verifySessionCookie,
} from '@dudousxd/nestjs-telescope';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

/** dist/server/telescope-ui.controller.js -> ../spa */
function defaultAssetsDir(): string {
  return fileURLToPath(new URL('../spa', import.meta.url));
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * The SPA is built once with a fixed Vite `base` of `/telescope/`, so every
 * asset URL in the built index.html is hardcoded to that placeholder. When the
 * dashboard is mounted under a custom path we rewrite those occurrences at serve
 * time instead of rebuilding the bundle per-path. When the path is the default
 * `'telescope'` the source and target strings are identical, so this is a no-op.
 */
function rewriteAssetBase(html: string, path: string): string {
  const injectedBase = `<script>window.__TELESCOPE_BASE__ = ${JSON.stringify(`/${path}`)};</script>`;
  const rebased = html.split('/telescope/').join(`/${path}/`);
  // Expose the runtime base before the bundle so the client can derive API URLs.
  if (rebased.includes('</head>')) {
    return rebased.replace('</head>', `${injectedBase}</head>`);
  }
  return `${injectedBase}${rebased}`;
}

@Controller()
export class TelescopeUiController {
  private readonly assetsDir: string;
  private readonly path: string;
  /**
   * Resolved from the SAME `dashboardAuth` the host passes to core (see `TelescopeUiModuleOptions`).
   * Only `secret`, `modes` and `unauthenticatedPage` are read here — minting and renewal stay
   * core's job. `null` whenever the host did not pass it, which is the default.
   */
  private readonly auth: ResolvedDashboardAuth | null;
  private readonly logger = new Logger(TelescopeUiController.name);
  private warned = false;

  constructor(@Inject(TELESCOPE_UI_OPTIONS) options: TelescopeUiModuleOptions) {
    this.assetsDir = options.assetsDir ?? defaultAssetsDir();
    this.path = normalizeTelescopePath(options.path);
    this.auth = resolveDashboardAuth(options.dashboardAuth);
  }

  // index.html references hash-named asset bundles. It MUST NOT be cached, or a
  // browser keeps loading a stale bundle across deploys (the classic "one widget
  // stuck loading / old labels after an upgrade"). The hashed assets below are
  // immutable and cached forever instead.
  //
  // Non-passthrough `@Res()` so a host's `dashboardAuth.unauthenticatedPage` can OWN the response
  // and serve its own page in place of the SPA. Without a hook this behaves exactly as before: the
  // shell is served to everyone, with no session check on this route at all, and the SPA's own auth
  // screen renders once its API calls come back 401. `sendHtml` sets the two headers that used to be
  // `@Header` decorators.
  @Get()
  async index(@Req() req: unknown, @Res() res: unknown): Promise<void> {
    if (await this.serveUnauthenticatedPage(req, res)) return;

    const indexPath = join(this.assetsDir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Telescope UI is not built. Run the package build.');
    }
    sendHtml(res, 200, rewriteAssetBase(readFileSync(indexPath, 'utf8'), this.path));
  }

  /**
   * Hand the response to the host's `unauthenticatedPage` when this navigation has no valid session.
   * Returns `true` when the host wrote a page (the caller must not also serve the SPA).
   *
   * Mode-A-only, deliberately: with `login` configured the SPA's own login form is the way in, so
   * replacing the shell would lock a Mode B host out of its own dashboard.
   */
  private async serveUnauthenticatedPage(req: unknown, res: unknown): Promise<boolean> {
    const auth = this.auth;
    const hook = auth?.unauthenticatedPage;
    if (!auth || !hook) return false;
    if (auth.modes.includes('login')) return false;
    if (this.hasValidSession(auth, req)) return false;

    try {
      await hook({ request: req, response: res, basePath: `/${this.path}` });
      if (responseAlreadyWritten(res)) return true;
      // Returned without writing. Serving the SPA is the only outcome that neither hangs the
      // request nor invents a page the host did not ask for — but it is almost certainly a bug.
      this.warnOnce(
        'dashboardAuth.unauthenticatedPage returned without writing a response; serving the SPA ' +
          'instead. The hook must write AND end the response it is given.',
      );
    } catch (error) {
      this.warnOnce(
        `dashboardAuth.unauthenticatedPage threw; serving the SPA instead. ${String(error)}`,
      );
      // It may have written headers before throwing; writing again would raise
      // ERR_HTTP_HEADERS_SENT on top of the original failure.
      if (responseAlreadyWritten(res)) return true;
    }
    // Falling back to the SPA is safe: every data route stays behind TelescopeGuard, so the visitor
    // gets the built-in auth screen, not the dashboard's contents.
    return false;
  }

  private hasValidSession(auth: ResolvedDashboardAuth, req: unknown): boolean {
    const cookieValue = parseCookieHeader(readCookieHeader(req))[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) return false;
    return verifySessionCookie(cookieValue, { secret: auth.secret }) !== null;
  }

  /** Once per process, not once per request: a broken hook fires on every unauthenticated visit. */
  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(message);
  }

  // Asset filenames are content-hashed by the build, so they're safe to cache
  // forever — a new bundle gets a new filename referenced by the (uncached) index.
  @Get('assets/:file')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  asset(@Param('file') file: string): StreamableFile {
    // Trust assumption: assetsDir holds build-produced files (not user-writable).
    // The basename + resolved-prefix checks below still prevent escaping assets/.
    // basename strips any path components, defeating traversal (../, nested, encoded).
    const safe = basename(file);
    if (safe !== file) throw new NotFoundException();
    const root = resolve(this.assetsDir, 'assets');
    const assetPath = resolve(root, safe);
    if (!assetPath.startsWith(root + sep) || !existsSync(assetPath)) {
      throw new NotFoundException();
    }
    const type = CONTENT_TYPES[extname(safe)] ?? 'application/octet-stream';
    return new StreamableFile(readFileSync(assetPath), { type });
  }
}
