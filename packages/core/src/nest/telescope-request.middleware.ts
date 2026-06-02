// packages/core/src/nest/telescope-request.middleware.ts
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { normalizeRequest } from './platform-request.js';
import { TelescopeService } from './telescope.service.js';

interface FinishableResponse {
  statusCode: number;
  once(event: 'finish', listener: () => void): void;
}

function asFinishable(res: unknown): FinishableResponse | null {
  const r = res as { statusCode?: unknown; once?: unknown };
  return typeof r?.once === 'function' ? (res as FinishableResponse) : null;
}

@Injectable()
export class TelescopeRequestMiddleware implements NestMiddleware {
  constructor(@Inject(TelescopeService) private readonly service: TelescopeService) {}

  use(req: unknown, res: unknown, next: (error?: unknown) => void): void {
    // Open the request batch for the whole downstream async execution.
    this.service.beginBatch('http');

    const request = normalizeRequest(req);
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
