// packages/core/src/entry/content.ts

export interface RequestContent {
  method: string;
  uri: string;
  headers: Record<string, unknown>;
  payload: unknown;
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
