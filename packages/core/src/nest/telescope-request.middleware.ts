// packages/core/src/nest/telescope-request.middleware.ts
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { normalizeRequest } from './platform-request.js';
import { TelescopeService } from './telescope.service.js';

/** The dashboard UI, its API and assets are all mounted under this prefix; skip them to avoid self-capture of the dashboard's own polling. */
const TELESCOPE_PATH_PREFIX = '/telescope';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

function isTelescopePath(url: string): boolean {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path === TELESCOPE_PATH_PREFIX || path.startsWith(`${TELESCOPE_PATH_PREFIX}/`);
}

function asFinishable(res: unknown): FinishableResponse | null {
  const r = res as { statusCode?: unknown; once?: unknown };
  return typeof r?.once === 'function' ? (res as FinishableResponse) : null;
}

@Injectable()
export class TelescopeRequestMiddleware implements NestMiddleware {
  constructor(@Inject(TelescopeService) private readonly service: TelescopeService) {}

  use(req: unknown, res: unknown, next: (error?: unknown) => void): void {
    const request = normalizeRequest(req);

    // Skip telescope's own routes (dashboard, API, assets) before any batch/recording work.
    // .exclude() can't do this reliably under a global prefix, so we gate in-middleware instead.
    if (isTelescopePath(request.url)) {
      next();
      return;
    }

    // Open the request batch for the whole downstream async execution.
    this.service.beginBatch('http');

    const startedAt = Date.now();
    const response = asFinishable(res);

    if (response) {
      response.once('finish', () => {
        this.service.record({
          type: EntryType.Request,
          content: {
            method: request.method,
            uri: request.url,
            headers: request.headers,
            ip: request.ip,
            statusCode: response.statusCode,
          },
          durationMs: Date.now() - startedAt,
        });
      });
    }

    next();
  }
}
