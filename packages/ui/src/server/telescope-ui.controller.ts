import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTelescopePath } from '@dudousxd/nestjs-telescope';
import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
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

  constructor(@Inject(TELESCOPE_UI_OPTIONS) options: TelescopeUiModuleOptions) {
    this.assetsDir = options.assetsDir ?? defaultAssetsDir();
    this.path = normalizeTelescopePath(options.path);
  }

  // index.html references hash-named asset bundles. It MUST NOT be cached, or a
  // browser keeps loading a stale bundle across deploys (the classic "one widget
  // stuck loading / old labels after an upgrade"). The hashed assets below are
  // immutable and cached forever instead.
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  index(): string {
    const indexPath = join(this.assetsDir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Telescope UI is not built. Run the package build.');
    }
    return rewriteAssetBase(readFileSync(indexPath, 'utf8'), this.path);
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
