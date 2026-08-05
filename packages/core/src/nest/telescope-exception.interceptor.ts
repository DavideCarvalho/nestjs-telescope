// packages/core/src/nest/telescope-exception.interceptor.ts
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, catchError, throwError } from 'rxjs';
import { captureException } from './exception-capture.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

/**
 * Captures exceptions thrown out of route handlers as `exception` entries so
 * they group into families, drive the `new-exception` alert, and feed AI
 * diagnosis.
 *
 * This is the HTTP/RPC/WS door. It is not the only one: a NestInterceptor runs
 * on the Nest execution pipeline and nowhere else, so a job body, a `@Cron`
 * callback or a durable step needs its own door. The decision (the 4xx policy),
 * the family hash and the entry shape live in `exception-capture.ts` and are
 * shared by every door — see the WHY there. If they were reimplemented per door
 * they would drift, and the dashboard would group the same error two ways
 * depending on which thread it was thrown on.
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
        // `captureException` applies the 4xx skip and never throws, so whatever
        // it decides, the error re-thrown below is the ORIGINAL one and the real
        // exception filter still builds the response exactly as before.
        captureException((input) => this.service.record(input), error, this.options.exceptions);
        return throwError(() => error);
      }),
    );
  }
}
