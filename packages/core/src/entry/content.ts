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
  name: string;
  queue: string;
  payload: unknown;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
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
