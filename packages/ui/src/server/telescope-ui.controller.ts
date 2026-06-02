import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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

@Controller('telescope')
export class TelescopeUiController {
  private readonly assetsDir: string;

  constructor(@Inject(TELESCOPE_UI_OPTIONS) options: TelescopeUiModuleOptions) {
    this.assetsDir = options.assetsDir ?? defaultAssetsDir();
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  index(): string {
    const indexPath = join(this.assetsDir, 'index.html');
    if (!existsSync(indexPath)) {
      throw new NotFoundException('Telescope UI is not built. Run the package build.');
    }
    return readFileSync(indexPath, 'utf8');
  }

  @Get('assets/:file')
  asset(@Param('file') file: string): StreamableFile {
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
