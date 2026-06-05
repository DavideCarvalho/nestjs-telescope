// packages/core/src/nest/telescope-exception.interceptor.ts
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, catchError, throwError } from 'rxjs';
import { EntryType } from '../entry/entry.js';
import { exceptionFamilyHash } from '../entry/exception-family-hash.js';
import { TelescopeService } from './telescope.service.js';

@Injectable()
export class TelescopeExceptionInterceptor implements NestInterceptor {
  constructor(@Inject(TelescopeService) private readonly service: TelescopeService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
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
}
