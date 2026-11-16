// packages/core/src/topology/ingest.controller.ts
//
// `POST <path>/api/ingest`: where tenant apps send their entries over HTTP. Mounted on every app
// (which controllers exist is fixed before async options resolve) and a 404 unless
// `topology: 'control-plane'`. It is not behind the console's `authorize` or `decorators`: the
// tenant's token is its credential.
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ingestHttpStatus } from './ingest.js';
import { TelescopeIngest } from './ingest.service.js';

/** The bearer token of an `Authorization` header. */
export function bearerToken(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

@Controller('telescope/api/ingest')
export class TelescopeIngestController {
  private readonly logger = new Logger('TelescopeIngest');

  constructor(@Inject(TelescopeIngest) private readonly ingest: TelescopeIngest) {}

  @Post()
  @HttpCode(202)
  async receive(
    @Body() body: unknown,
    @Headers('authorization') authorization: unknown,
  ): Promise<{ stored: number; duplicate: number }> {
    const handler = this.ingest.handler;
    if (handler === null) throw new NotFoundException();
    const outcome = await handler({ token: bearerToken(authorization), body });
    if (outcome.status === 'stored') {
      return { stored: outcome.stored, duplicate: outcome.duplicate };
    }
    if ('reason' in outcome) this.logger.warn(`refused a batch: ${outcome.reason}`);
    throw new HttpException({ error: outcome.status }, ingestHttpStatus(outcome));
  }
}
