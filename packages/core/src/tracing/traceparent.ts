// packages/core/src/tracing/traceparent.ts
//
// W3C Trace Context (`traceparent` / `tracestate`): the header pair OpenTelemetry, a load balancer
// or another language's SDK all understand.
//
//   traceparent: 00-<trace id: 32 hex>-<parent span id: 16 hex>-<flags: 2 hex>
//
// Kept here rather than reusing `@dudousxd/nestjs-context`'s parser: that package is an optional
// peer, and propagation needs the full validity rules (version `ff`, an all-zero span id, a future
// version's extra fields) plus `tracestate`.
import { randomBytes } from 'node:crypto';

/** A parsed `traceparent`. */
export interface TraceParent {
  /** 32 lowercase hex characters, never all zeros. */
  traceId: string;
  /** The caller's span id: 16 lowercase hex characters, never all zeros. */
  spanId: string;
  /** Trace flags, 2 hex characters (`01` = sampled). */
  flags: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
/** What the spec asks a vendor to keep of `tracestate`. */
const MAX_TRACESTATE = 512;

function first(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Parse a `traceparent` header. `undefined` when it is absent or malformed, the version is `ff`,
 * or the trace or span id is all zeros (the spec says to ignore all of these). A future version
 * with extra fields is read for its first four.
 */
export function parseTraceparent(value: unknown): TraceParent | undefined {
  const raw = first(value)?.trim().toLowerCase();
  if (raw === undefined || raw.length > 512) return undefined;
  const match = TRACEPARENT_RE.exec(raw);
  if (match === null) return undefined;
  const version = match[1] as string;
  const traceId = match[2] as string;
  const spanId = match[3] as string;
  const flags = match[4] as string;
  if (version === 'ff') return undefined;
  // Version 00 has exactly four fields.
  if (version === '00' && raw.length !== 55) return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, flags };
}

/** A `tracestate` header worth forwarding (printable ASCII, at most 512 characters), or `undefined`. */
export function parseTracestate(value: unknown): string | undefined {
  const raw = first(value)?.trim();
  if (raw === undefined || raw === '' || raw.length > MAX_TRACESTATE) return undefined;
  return /^[\x20-\x7e]+$/.test(raw) ? raw : undefined;
}

/** `00-<traceId>-<spanId>-<flags>`. */
export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

/** Whether `id` is a W3C trace id (32 lowercase hex, not all zeros). */
export function isTraceId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) && id !== ZERO_TRACE;
}

/** A fresh trace id. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** A fresh span id. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}
