// packages/core/src/nest/telescope-request.middleware.ts
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { normalizeRoute } from '../query/normalize-route.js';
import { normalizeRequest } from './platform-request.js';
import { TelescopeService } from './telescope.service.js';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

/**
 * The dashboard UI, its API and assets are all mounted under the configured
 * path prefix; skip them to avoid self-capture of the dashboard's own polling.
 */
function isTelescopePath(url: string, prefix: string): boolean {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path === prefix || path.startsWith(`${prefix}/`);
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
    if (isTelescopePath(request.url, `/${this.service.path}`)) {
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
          // A readable normalized route (e.g. "GET /api/base/:id/mel") groups
          // request entries by endpoint via the indexed family_hash column and
          // doubles as the human label — no content hydration needed.
          familyHash: normalizeRoute(request.method, request.url),
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

/**
 * Builds a framework-agnostic `(req, res, next)` request-capture handler for
 * hosts that register it globally via `app.use(...)` in their bootstrap —
 * required when the app uses `setGlobalPrefix(...)`, which scopes NestJS module
 * middleware so the built-in capture would only see `/`. Pair with
 * `TelescopeModule.forRoot({ registerRequestMiddleware: false })`.
 *
 * @example
 *   const app = await NestFactory.create(AppModule);
 *   app.use(telescopeRequestCapture(app.get(TelescopeService)));
 */
export function telescopeRequestCapture(
  service: TelescopeService,
): (req: unknown, res: unknown, next: (error?: unknown) => void) => void {
  const middleware = new TelescopeRequestMiddleware(service);
  return (req, res, next) => middleware.use(req, res, next);
}
