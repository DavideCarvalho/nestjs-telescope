// packages/core/src/ai/diagnoser.ts

/**
 * The request entry's contribution to a {@link DiagnoseContext}. Present only for
 * a SERVER exception, whose sibling request lives in the same batch and carries
 * the route/method/status/duration the diagnoser uses to locate the failure. A
 * client (browser) exception has no sibling request, so this is absent and the
 * client-specific fields ({@link DiagnoseContext.url} / `userAgent`) carry the
 * front-end context instead.
 */
export interface DiagnoseRequestContext {
  /** Request route/URI (e.g. `/api/orders/:id`), or `null` when not captured. */
  route: string | null;
  /** HTTP method (e.g. `POST`), or `null`. */
  method: string | null;
  /** Response status code, or `null`. */
  statusCode: number | null;
  /** Request duration in milliseconds, or `null`. */
  durationMs: number | null;
}

/**
 * Everything a {@link ExceptionDiagnoser} is given to triage one exception. Built
 * by core from storage (the exception entry PLUS its batch siblings) so the
 * diagnoser stays a pure, side-effect-free function of its input — it never
 * touches storage, the network, or the host.
 *
 * Privacy contract: every string here is the ALREADY-REDACTED content as stored
 * (the Recorder redacts at capture time). The diagnoser must not be handed raw
 * payloads, and SQL is passed WITHOUT bindings (values never leave the box just
 * because diagnosis ran).
 */
export interface DiagnoseContext {
  /** Exception class name (e.g. `TypeError`). */
  exceptionClass: string;
  /** Exception message (redacted at capture). */
  message: string;
  /** Full stack string, or `null` when none was captured. */
  stack: string | null;
  /**
   * Sibling request context for a server exception, or `null` for a browser
   * (client) exception (which carries {@link url}/{@link userAgent} instead).
   */
  request: DiagnoseRequestContext | null;
  /** Page URL for a browser (client) exception, else `null`. */
  url: string | null;
  /** Reporting browser's user-agent for a client exception, else `null`. */
  userAgent: string | null;
  /**
   * SQL of the queries captured in the SAME batch as the exception, newest-last,
   * SQL strings ONLY (no bindings) and already redacted. Empty when the batch had
   * no queries. Bounded by the builder so a chatty request can't blow the prompt.
   */
  recentQueries: string[];
  /**
   * Whether this is a browser-reported `client_exception` (vs a server
   * exception). Lets a diagnoser tune its guidance (front-end vs back-end).
   */
  client: boolean;
  /**
   * Times this exception's family was seen in the alerting window (>= 1). A high
   * count signals a recurring failure rather than a one-off.
   */
  occurrenceCount: number;
}

/**
 * Pluggable AI triage backend. Defined in CORE so the public option shape carries
 * zero AI-SDK dependency: the host supplies an implementation (e.g. the
 * `createAiSdkDiagnoser` from `@dudousxd/nestjs-telescope-ai`, or any custom
 * sink). It receives a fully-built {@link DiagnoseContext} and returns a markdown
 * report.
 *
 * Contract:
 *  - `diagnose` MUST resolve with a markdown string, or REJECT on timeout/error.
 *    Core owns the failure handling (the on-demand endpoint maps a rejection to a
 *    safe 502; auto-mode swallows it), so the implementation should NOT try to
 *    return a "friendly error string" — a rejection is the signal.
 *  - It must be side-effect-free with respect to Telescope: it only reads its
 *    input and calls out to its model.
 */
export interface ExceptionDiagnoser {
  /** Produce a markdown diagnosis for `context`, or reject on timeout/error. */
  diagnose(context: DiagnoseContext): Promise<string>;
}

/**
 * AI exception-diagnosis options on {@link TelescopeModuleOptions}. The SHAPE is
 * defined in core (so core stays AI-SDK-agnostic), but a host typically supplies
 * `diagnoser` from `@dudousxd/nestjs-telescope-ai`.
 */
export interface TelescopeAiOptions {
  /** The backend that turns a {@link DiagnoseContext} into a markdown report. */
  diagnoser: ExceptionDiagnoser;
  /**
   * `'on-demand'` (default): diagnosis runs only when an operator clicks the
   * dashboard button (`POST <telescope>/api/exceptions/:id/diagnose`).
   *
   * `'auto'`: ALSO run diagnosis (fire-and-forget) the first time a NEW exception
   * family is seen on the flush path — reusing the same first-seen signal the
   * `new-exception` alert uses — so the result is cached and, when an alert fires
   * for that family, can be attached to the alert payload if ready in time.
   */
  mode?: 'auto' | 'on-demand';
}
