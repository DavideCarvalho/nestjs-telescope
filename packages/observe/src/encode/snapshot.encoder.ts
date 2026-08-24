import type { Entry, RequestContent } from '@dudousxd/nestjs-telescope';
import { EntryType, userIdentityTag } from '@dudousxd/nestjs-telescope';
import type { AssembledBatch } from '../assemble/assembled-batch.js';
import type { ResolvedObserveOptions } from '../observe-options.js';
import type { WireError, WireSnapshot, WireSnapshotAttributes } from '../wire/telemetry-wire.js';
import { toChildSpans } from './child-spans.js';
import { entryStartMs } from './entry-start.js';
import { operationId } from './operation-id.js';
import { asRecord, finiteNumber, nonEmptyString, parseEntryTags } from './tag-values.js';
import { toWireError } from './wire-error.js';

/**
 * The request's own failure, and the one entry that will NOT also appear as a
 * span. A server `exception` wins over a browser-reported `client_exception`:
 * the former is this request throwing, the latter is a page reporting an error
 * that merely landed in the same batch.
 */
function pickFailure(children: readonly Entry[]): Entry | null {
  let clientFailure: Entry | null = null;
  for (const child of children) {
    if (child.type === EntryType.Exception) return child;
    if (child.type === EntryType.ClientException && clientFailure === null) clientFailure = child;
  }
  return clientFailure;
}

function attributes(content: RequestContent): WireSnapshotAttributes | undefined {
  const method = nonEmptyString(content.method);
  const statusCode = finiteNumber(content.statusCode);
  const uri = nonEmptyString(content.uri);
  const value: WireSnapshotAttributes = {
    ...(method !== undefined ? { m: method } : {}),
    ...(statusCode !== undefined ? { sc: statusCode } : {}),
    ...(uri !== undefined ? { ou: uri } : {}),
  };
  return Object.keys(value).length > 0 ? value : undefined;
}

/** The `user:<id>` convention from core's `userTagger`, minus its prefix. */
function userId(content: RequestContent): string | undefined {
  const tag = userIdentityTag(content.user);
  return tag === null ? undefined : tag.slice('user:'.length);
}

/**
 * One request batch as an Observe snapshot, or null when the batch is not
 * rooted at a request (a job batch goes through `encodeJob` instead).
 *
 * Never emits `st`: their own encoder accepts the key but their collector
 * rejects the whole POST with a 400 when it is present.
 */
export function encodeSnapshot(
  batch: AssembledBatch,
  options: ResolvedObserveOptions,
): WireSnapshot | null {
  const root = batch.root;
  if (root === null || root.type !== EntryType.Request) return null;
  const raw = asRecord(root.content);
  if (raw === null) return null;
  const content = raw as unknown as RequestContent;

  const failure = pickFailure(batch.children);
  const error: WireError | null = failure === null ? null : toWireError(failure);
  // A failure that yielded no usable error is not "consumed", so it still earns
  // its span rather than vanishing from the trace entirely.
  const consumed = error === null ? null : failure;

  const uri = nonEmptyString(content.uri);
  const operation =
    uri === undefined ? undefined : operationId(nonEmptyString(content.method), uri);
  const duration = finiteNumber(root.durationMs);
  const user = userId(content);
  const attrs = attributes(content);
  // Always an array, even when spans are switched off: the collector requires
  // `t` to be present on every snapshot.
  const spans = options.include.spans
    ? toChildSpans(batch.children, entryStartMs(root), consumed)
    : [];

  // `user:<id>` is dropped: the id already travels in `u`, and repeating it as a
  // tag turns a per-user dimension into unbounded tag cardinality.
  const tags = parseEntryTags(root.tags, (key) => key === 'user');
  tags.origin = batch.origin;

  return {
    ct: new Date(entryStartMs(root)).toISOString(),
    ti: nonEmptyString(root.traceId) ?? root.batchId,
    p: 'http',
    tg: tags,
    ...(duration !== undefined ? { d: duration } : {}),
    ...(operation !== undefined ? { op: operation } : {}),
    t: spans,
    ...(attrs !== undefined ? { a: attrs } : {}),
    ...(error !== null ? { e: error } : {}),
    ...(user !== undefined ? { u: user } : {}),
  };
}
