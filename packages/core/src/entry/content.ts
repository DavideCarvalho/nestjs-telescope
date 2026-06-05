// packages/core/src/entry/content.ts

export interface RequestContent {
  method: string;
  uri: string;
  headers: Record<string, unknown>;
  payload: unknown;
  /**
   * The resolved authenticated user for the request (or `null` when anonymous).
   * Defaults to the raw request's `user` (the common Passport/guard convention);
   * a host can customize it via `TelescopeModuleOptions.resolveUser`. Redacted by
   * the Recorder like any other content.
   */
  user: unknown;
  response: unknown;
  statusCode: number | null;
  ip: string | null;
  memoryMb: number | null;
}

export interface QueryContent {
  sql: string;
  bindings: unknown[];
  connection: string | null;
  slow: boolean;
}

export interface JobContent {
  id: string | null;
  name: string;
  queue: string;
  payload: unknown;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number | null;
  waitMs: number | null;
  failureReason: string | null;
}

export interface ExceptionContent {
  class: string;
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
}

export interface MailContent {
  mailer: string;
  from: string | null;
  to: string[];
  subject: string | null;
  preview: string | null;
  status: 'sent' | 'failed';
}

export interface HttpClientContent {
  method: string;
  url: string;
  host: string | null;
  statusCode: number | null;
  durationMs: number;
}

export interface CacheContent {
  operation: 'get' | 'set';
  key: string;
  /** `true`/`false` for a get (hit vs miss); `null` for a set (not applicable). */
  hit: boolean | null;
}

/**
 * A developer-initiated debug dump (see `telescopeDump`). The `value` is the
 * arbitrary payload to inspect (redacted by the Recorder like any other
 * content); `label` is an optional caller-supplied tag, `null` when omitted.
 */
export interface DumpContent {
  label: string | null;
  value: unknown;
}

/**
 * An application event emitted through `@nestjs/event-emitter`'s `EventEmitter2`.
 * `name` is the event name (`String(event)`); `payload` is the emitted value(s)
 * (a single value when one was emitted, else the array of values), redacted by
 * the Recorder; `listenerCount` is how many listeners were attached at emit time
 * (`null` when the emitter can't report it).
 */
export interface EventContent {
  name: string;
  payload: unknown;
  listenerCount: number | null;
}

/**
 * A Nest `Logger` line captured by the logs watcher. `level` is the log level
 * (`log`/`error`/`warn`/`debug`/`verbose`); `message` is the stringified message;
 * `context` is the logger context (`null` when none was supplied).
 */
export interface LogContent {
  level: string;
  message: string;
  context: string | null;
}

/**
 * An ORM entity lifecycle change captured by a model watcher (e.g. MikroORM).
 * `action` is the lifecycle kind; `entity` is the entity class name; `id` is the
 * primary key as a string (`null` when not yet assigned); `changes` is the
 * change set payload (the changed columns), redacted by the Recorder, or `null`
 * when the ORM doesn't expose one (e.g. a delete).
 */
export interface ModelContent {
  action: 'create' | 'update' | 'delete';
  entity: string;
  id: string | null;
  changes: Record<string, unknown> | null;
}

/**
 * A browser-reported error ingested via the public `POST /api/client-errors`
 * endpoint (see {@link EntryType.ClientException}). Everything beyond `message`
 * is optional because the browser is UNTRUSTED — the controller validates the
 * structure and length-caps the strings before recording, and `extra` (an
 * arbitrary, host-defined bag of debugging context) is bounded by the normal
 * redaction budget at record time exactly like every other content payload.
 *
 * Field intent:
 *  - `message`        — the error message (required; the one field we insist on).
 *  - `name`           — the error class/name (e.g. `TypeError`), when the browser
 *                       supplied one. Feeds the family hash alongside `message`.
 *  - `stack`          — the JS stack string. Its TOP frame also feeds the family
 *                       hash, mirroring how server exceptions group.
 *  - `componentStack` — React's component stack (from an error boundary), kept
 *                       separate from `stack` so the dashboard can show both.
 *  - `url`            — the page URL where the error happened (the front-end
 *                       analogue of a request route).
 *  - `userAgent`      — the reporting browser's UA string.
 *  - `user`           — a host-supplied user identity (id/_id/email pivoted into
 *                       a `user:<id>` tag, mirroring the server `userTagger`).
 *  - `release`        — an app version / build id, so errors can be grouped by
 *                       deploy.
 *  - `extra`          — free-form debugging context; redacted/bounded like any
 *                       other content (never trusted to be small or shallow).
 *  - `clientIp`       — filled in BY THE SERVER from `request.ip` / the first
 *                       `x-forwarded-for` hop; never read from the body.
 */
export interface ClientExceptionContent {
  message: string;
  name: string | null;
  stack: string | null;
  componentStack: string | null;
  url: string | null;
  userAgent: string | null;
  user: unknown;
  release: string | null;
  extra: Record<string, unknown> | null;
  clientIp: string | null;
}

/**
 * A Redis command issued through a wrapped client (e.g. ioredis). `command` is
 * the command name (uppercased, e.g. `GET`); `args` are the command arguments,
 * redacted by the Recorder; `durationMs` is the round-trip time in milliseconds
 * (`null` when it couldn't be measured).
 */
export interface RedisContent {
  command: string;
  args: unknown[];
  durationMs: number | null;
}
