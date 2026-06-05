// packages/core/src/nest/telescope-exception.interceptor.ts
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, catchError, throwError } from 'rxjs';
import { EntryType } from '../entry/entry.js';
import { exceptionFamilyHash } from '../entry/exception-family-hash.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/**
 * Captures exceptions thrown out of route handlers as `exception` entries so
 * they group into families, drive the `new-exception` alert, and feed AI
 * diagnosis.
 *
 * WHY a 4xx default-skip: expected 4xx control flow is NOT an incident. A
 * `ForbiddenException` (403), `NotFoundException` (404) or a validation 400 is
 * the framework doing its job — permission denied, resource missing, bad input.
 * Recording those as exception entries means every permission denial in
 * production opens a NEW exception family (the family hash keys on
 * name+message+top-frame, so each call site is its own family), which fires the
 * `new-exception` Slack alert and, in AI auto-mode, spends Bedrock tokens on a
 * "diagnosis" of intended behaviour. We hit exactly this: Telescope's own
 * client-errors `authorize` gate threw a 403, the interceptor captured it as a
 * brand-new family, paged Slack, and burned an AI diagnosis. So by default a
 * NestJS `HttpException` whose status is < 500 is dropped here.
 *
 * The information is NOT lost: the request-capture middleware records the 4xx
 * `statusCode` on its own `request` entry (independently, on the response
 * `finish` event), so the dashboard still shows the 4xx — it just doesn't spawn
 * an exception family, can't fire `new-exception`, and can't trigger diagnosis.
 *
 * The escape hatch is `exceptions.captureHttp4xx: true`, which restores the
 * pre-change behaviour (capture everything) for hosts that genuinely treat 4xx
 * as exceptions worth grouping/alerting on.
 *
 * NOT affected by this filter: 5xx HttpExceptions (real server errors),
 * non-HTTP errors (any thrown `Error` that isn't an `HttpException`), and the
 * client-errors ingestion endpoint's `client_exception` entries (recorded
 * directly in the controller, never through this interceptor — those are
 * deliberate browser reports and are always kept).
 */
@Injectable()
export class TelescopeExceptionInterceptor implements NestInterceptor {
  constructor(
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
  ) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (this.shouldSkipAsControlFlow(error)) {
          // Re-throw untouched so the real exception filter still builds the 4xx
          // response — we only decline to RECORD it as an exception entry.
          return throwError(() => error);
        }
        const err = error instanceof Error ? error : new Error(String(error));
        this.service.record({
          type: EntryType.Exception,
          // Include the top stack frame so two unrelated call sites that throw
          // the same name+message stay distinct families (shared with the
          // client-error controller so both sources group identically).
          familyHash: exceptionFamilyHash({
            name: err.name,
            message: err.message,
            stack: err.stack ?? null,
          }),
          content: {
            class: err.name,
            message: err.message,
            stack: err.stack ?? null,
            context: {},
          },
        });
        // Re-throw the original error — the real exception filter still handles the response.
        return throwError(() => error);
      }),
    );
  }

  /**
   * Decides whether a thrown error is expected 4xx control flow that should NOT
   * become an exception entry. True only for a NestJS `HttpException` whose
   * `getStatus()` is a 4xx (>= 400 and < 500), and only while the
   * `captureHttp4xx` escape hatch is off (the default). Detected via
   * `instanceof HttpException` from `@nestjs/common` (a peer dep), which also
   * covers all the built-in subclasses (`ForbiddenException`,
   * `NotFoundException`, `BadRequestException`, the validation-pipe 400, …).
   */
  private shouldSkipAsControlFlow(error: unknown): boolean {
    if (this.options.exceptions?.captureHttp4xx === true) {
      return false;
    }
    if (!(error instanceof HttpException)) {
      return false;
    }
    const status = error.getStatus();
    return status >= 400 && status < 500;
  }
}
