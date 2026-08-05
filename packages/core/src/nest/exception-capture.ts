// packages/core/src/nest/exception-capture.ts
import { HttpException, Logger } from '@nestjs/common';
import type { ExceptionContent } from '../entry/content.js';
import { EntryType, type RecordInput } from '../entry/entry.js';
import { exceptionFamilyHash } from '../entry/exception-family-hash.js';
import type { ExceptionsOptions } from './telescope.options.js';

/**
 * The ONE place a thrown error becomes an `exception` entry.
 *
 * WHY it is a module and not just the interceptor's body: for a long time the
 * only door into the exception family was
 * {@link TelescopeExceptionInterceptor}, a `NestInterceptor` — which runs on the
 * Nest execution pipeline and NOWHERE else. A BullMQ job body, a `@Cron`
 * callback, a durable workflow step, an `@OnEvent` listener: none of those go
 * through an interceptor, so a throw inside them never opened an exception
 * family, never fired `new-exception`, never got an AI diagnosis, and never
 * appeared in the exceptions view. It survived at best as `status: 'failed'` on
 * the unit's own job entry — a string in a content field, invisible to every
 * mechanism that keys off exceptions.
 *
 * The fix is not "let each watcher build an exception entry too". Three things
 * MUST stay identical across every door or the dashboard silently splits into
 * parallel realities: the family hash (two identical errors from the same frame
 * must be ONE family whether they were thrown in a request or in a job), the
 * 4xx control-flow policy (see {@link isExpectedHttpControlFlow} — the reason
 * it exists is an incident, not a preference), and the entry shape. So the
 * decision and the record live here, and the interceptor, `TelescopeService`
 * and every watcher call in.
 */

/** Logger for the capture path itself. Named for the module, not a class, so a
 *  swallowed failure is traceable to this file rather than to whichever door
 *  happened to call in. */
const logger = new Logger('TelescopeExceptionCapture');

/**
 * Where a throw happened, for the doors that know something the stack doesn't.
 *
 * The Nest interceptor passes nothing (the request entry in the same batch
 * already says which route it was). A queue or schedule watcher DOES have
 * context worth keeping — which queue, which job id, which cron task — because
 * off the request path there is no sibling `request` entry to read it from.
 */
export interface ExceptionCaptureDetails {
  /** Merged into the entry's `content.context` (queue + job name, task name, …). */
  context?: Record<string, unknown>;
  /** Extra tags appended to the exception entry. */
  tags?: string[];
}

/**
 * Decides whether a thrown error is expected 4xx control flow that should NOT
 * become an exception entry. True only for a NestJS `HttpException` whose
 * `getStatus()` is a 4xx (>= 400 and < 500), and only while the
 * `captureHttp4xx` escape hatch is off (the default).
 *
 * WHY the default-skip: expected 4xx control flow is NOT an incident. A
 * `ForbiddenException` (403), `NotFoundException` (404) or a validation 400 is
 * the framework doing its job — permission denied, resource missing, bad input.
 * Recording those as exception entries means every permission denial in
 * production opens a NEW exception family (the family hash keys on
 * name+message+top-frame, so each call site is its own family), which fires the
 * `new-exception` Slack alert and, in AI auto-mode, spends model tokens on a
 * "diagnosis" of intended behaviour. We hit exactly this: Telescope's own
 * client-errors `authorize` gate threw a 403, it was captured as a brand-new
 * family, paged Slack, and burned an AI diagnosis.
 *
 * This applies to EVERY door, not just HTTP. An `HttpException` thrown inside a
 * job body is the same expected control flow (hosts routinely reuse
 * `NotFoundException` in services that both a controller and a worker call), so
 * a queue retry storm must not be able to page on-call through the back door
 * that the front door was hardened against.
 *
 * Detected via `instanceof HttpException` from `@nestjs/common` (a peer dep),
 * which also covers all the built-in subclasses (`ForbiddenException`,
 * `NotFoundException`, `BadRequestException`, the validation-pipe 400, …).
 */
export function isExpectedHttpControlFlow(
  error: unknown,
  options: ExceptionsOptions | undefined,
): boolean {
  if (options?.captureHttp4xx === true) {
    return false;
  }
  if (!(error instanceof HttpException)) {
    return false;
  }
  const status = error.getStatus();
  return status >= 400 && status < 500;
}

/**
 * Build the `exception` entry for a thrown value. A non-`Error` throw (a string,
 * a rejected object) is normalised into an `Error` so `class`/`message` are
 * always populated and the family hash is always computable.
 */
export function toExceptionRecordInput(
  error: unknown,
  details?: ExceptionCaptureDetails,
): RecordInput<ExceptionContent> {
  const err = error instanceof Error ? error : new Error(String(error));
  const input: RecordInput<ExceptionContent> = {
    type: EntryType.Exception,
    // Include the top stack frame so two unrelated call sites that throw the
    // same name+message stay distinct families (shared with the client-error
    // controller so browser and server errors group identically).
    familyHash: exceptionFamilyHash({
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    }),
    content: {
      class: err.name,
      message: err.message,
      stack: err.stack ?? null,
      context: details?.context ?? {},
    },
  };
  if (details?.tags !== undefined && details.tags.length > 0) {
    input.tags = [...details.tags];
  }
  return input;
}

/**
 * Apply the 4xx policy and, when the error survives it, hand the exception
 * entry to `record`. Returns whether an entry was recorded (the watchers ignore
 * it; it exists so tests and future doors can assert the decision).
 *
 * This function NEVER throws. Every caller is on the host's own failure path —
 * an rxjs `catchError`, a `catch` block that is about to re-throw a job's error
 * — and a throw from here would REPLACE the host's original error with a
 * Telescope error, turning an observability bug into a data-loss bug. Building
 * the entry (`String(error)` on a hostile `toString`, a getter on `err.stack`)
 * runs on the host's thread, so the guard has to be here and not only inside
 * the Recorder.
 */
export function captureException(
  record: (input: RecordInput) => void,
  error: unknown,
  options: ExceptionsOptions | undefined,
  details?: ExceptionCaptureDetails,
): boolean {
  try {
    if (isExpectedHttpControlFlow(error, options)) {
      return false;
    }
    record(toExceptionRecordInput(error, details));
    return true;
  } catch (captureError) {
    const message = captureError instanceof Error ? captureError.message : String(captureError);
    logger.error(`Telescope failed to record an exception entry: ${message}`);
    return false;
  }
}
