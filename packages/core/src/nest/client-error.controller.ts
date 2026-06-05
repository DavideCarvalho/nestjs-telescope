// packages/core/src/nest/client-error.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { EntryType } from '../entry/entry.js';
import { exceptionFamilyHash } from '../entry/exception-family-hash.js';
import { userIdentityTag } from '../tagging/tagger.js';
import { ClientErrorRateLimiter } from './client-error-rate-limiter.js';
import { validateClientErrorBody } from './client-error-validation.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/** Default per-IP requests/minute when `rateLimit` is omitted. */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
/** Default accepted body size (32 KB) when `maxBodyBytes` is omitted. */
const DEFAULT_MAX_BODY_BYTES = 32_768;

/** HTTP 413 isn't a named Nest exception; this thin subclass keeps the status. */
class PayloadTooLargeException extends HttpException {
  constructor(message: string) {
    super(message, 413);
  }
}

class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super(message, 429);
  }
}

/**
 * Public front-end error ingestion. Mounted on a SEPARATE controller from the
 * gated dashboard API (like {@link TelescopeAuthController}) so it carries NO
 * `@UseGuards(TelescopeGuard)` — ordinary users' browsers hit it, they have no
 * dashboard session. Security is instead the per-endpoint knobs in
 * {@link ClientErrorsOptions}: an opt-in `enabled` flag (404 while off), a body
 * byte cap, a per-IP token bucket, and an optional `authorize` hook.
 *
 * Records every accepted error as a `client_exception` entry through the normal
 * pipeline so it composes with new-exception alerts, per-type prune/archive, and
 * the dashboard — with a family-hash mirroring server exceptions and the
 * `failed` / `client` / `user:<id>` tags.
 */
@Controller('telescope/api/client-errors')
export class ClientErrorController {
  private readonly logger = new Logger(ClientErrorController.name);
  /** Per-pod, bounded token bucket (lazily built so a disabled endpoint is free). */
  private rateLimiter: ClientErrorRateLimiter | null = null;
  /** One warn for an authorize-hook throw, so a flaky hook can't spam logs. */
  private warnedAuthorize = false;

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TelescopeService) private readonly service: TelescopeService,
  ) {}

  @Post()
  @HttpCode(204)
  async ingest(@Body() body: unknown, @Req() request: unknown): Promise<void> {
    const config = this.options.clientErrors;
    // Disabled (or unconfigured) => the route doesn't exist for this host. We
    // 404 rather than 403 so a probe can't even tell ingestion is wired.
    if (config === undefined || config.enabled !== true) {
      throw new NotFoundException();
    }

    // 1) authorize hook runs FIRST (before any work): a session/header gate.
    if (config.authorize !== undefined) {
      const allowed = await this.runAuthorize(config.authorize, request);
      if (!allowed) throw new ForbiddenException();
    }

    // 2) body byte cap, BEFORE validation, so a huge payload is cheap to reject.
    const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (this.bodyByteSize(body) > maxBodyBytes) {
      throw new PayloadTooLargeException('Body exceeds the configured size limit');
    }

    // 3) per-IP rate limit (per-pod, best-effort — see the multi-replica caveat).
    const ip = this.clientIp(request);
    if (!this.limiter(config).tryConsume(ip ?? 'unknown')) {
      throw new TooManyRequestsException('Rate limit exceeded');
    }

    // 4) structural validation — never trust the body; no echo on failure.
    const validation = validateClientErrorBody(body);
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }
    const content = validation.value;

    // 5) record through the normal pipeline: family-hash from name+message+top
    //    frame (mirrors server exceptions), and the composing tags.
    const tags = ['failed', 'client'];
    const userTag = userIdentityTag(content.user);
    if (userTag !== null) tags.push(userTag);

    this.service.record({
      type: EntryType.ClientException,
      familyHash: exceptionFamilyHash({
        name: content.name ?? '',
        message: content.message,
        stack: content.stack,
      }),
      tags,
      content: { ...content, clientIp: ip },
    });
  }

  /** Build (once) the per-pod token bucket from the resolved rate-limit config. */
  private limiter(
    config: NonNullable<TelescopeModuleOptions['clientErrors']>,
  ): ClientErrorRateLimiter {
    if (this.rateLimiter === null) {
      this.rateLimiter = new ClientErrorRateLimiter({
        perMinute: config.rateLimit?.perMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      });
    }
    return this.rateLimiter;
  }

  /**
   * Run the host's authorize hook defensively: a throw is a DENIAL (fail closed)
   * and warn-logged once, so a buggy hook never 500s the public endpoint nor
   * floods the logs.
   */
  private async runAuthorize(
    authorize: (request: unknown) => boolean | Promise<boolean>,
    request: unknown,
  ): Promise<boolean> {
    try {
      return (await authorize(request)) === true;
    } catch (error) {
      if (!this.warnedAuthorize) {
        this.warnedAuthorize = true;
        this.logger.warn(
          `Telescope clientErrors authorize hook threw; treating as denial. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  }

  /**
   * Best-effort serialized byte size of the parsed body. The framework already
   * parsed JSON by the time we get here, so we re-serialize to measure bytes
   * (UTF-8) — a tight enough proxy for the wire size to reject oversized
   * payloads. A non-serializable body counts as 0 (it'll fail validation anyway).
   */
  private bodyByteSize(body: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
    } catch {
      return 0;
    }
  }

  /**
   * Extract the reporting client's IP: the first hop of `x-forwarded-for` when
   * present (the original client behind a proxy), else `request.ip` /
   * `socket.remoteAddress`. Returns `null` when nothing usable is found.
   */
  private clientIp(request: unknown): string | null {
    // Read via `Reflect.get` (not `Object.keys`) because a platform request
    // exposes `headers`/`ip`/`socket` through prototype getters, not own
    // enumerable keys — enumerating would miss them entirely.
    const headers = readProp(request, 'headers');
    const forwarded = readProp(headers, 'x-forwarded-for');
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const firstHop = forwarded.split(',')[0]?.trim();
      if (firstHop !== undefined && firstHop.length > 0) return firstHop;
    }
    const ip = readProp(request, 'ip');
    if (typeof ip === 'string' && ip.length > 0) return ip;
    const remoteAddress = readProp(readProp(request, 'socket'), 'remoteAddress');
    return typeof remoteAddress === 'string' ? remoteAddress : null;
  }
}

/** Read a single property from an unknown object (incl. prototype getters),
 *  returning `undefined` for a non-object or missing property — no cast. */
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return Reflect.get(value, key);
}
