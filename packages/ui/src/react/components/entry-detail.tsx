import type { EntryWithBatch } from '../../client/index.js';
import { useMeta } from '../use-telescope-queries.js';
import { BatchTimeline } from './batch-timeline.js';
import { CacheBadge } from './cache-badge.js';
import { RequestTimeline } from './request-timeline.js';
import { buildTraceHref } from './trace-link.js';

export function EntryDetail({
  entry,
  onSelect,
}: { entry: EntryWithBatch; onSelect?: (id: string) => void }): JSX.Element {
  const { data: meta } = useMeta();
  const showTimeline = entry.type === 'request' && entry.batch.length > 1;
  return (
    <div className="grid grid-cols-3 gap-6">
      <section className="col-span-2">
        <h2 className="mb-2 flex items-center gap-2 text-sm text-emerald-400">
          {entry.type}
          {entry.type === 'cache' ? <CacheBadge content={entry.content} /> : null}
        </h2>
        {showTimeline ? (
          <div className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Timeline</h3>
            <RequestTimeline batch={entry.batch} requestId={entry.id} onSelect={onSelect} />
          </div>
        ) : null}
        {entry.type === 'dump' ? (
          <DumpBody content={entry.content} />
        ) : entry.type === 'event' ? (
          <EventBody content={entry.content} />
        ) : entry.type === 'log' ? (
          <LogBody content={entry.content} />
        ) : entry.type === 'model' ? (
          <ModelBody content={entry.content} />
        ) : entry.type === 'redis' ? (
          <RedisBody content={entry.content} />
        ) : (
          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
            {JSON.stringify(entry.content, null, 2)}
          </pre>
        )}
      </section>
      <aside>
        {entry.traceId ? (
          <div className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Trace</h3>
            <TraceRow
              traceId={entry.traceId}
              spanId={entry.spanId}
              traceLink={meta?.traceLink ?? null}
            />
          </div>
        ) : null}
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Batch ({entry.batch.length})
        </h3>
        <BatchTimeline batch={entry.batch} currentId={entry.id} onSelect={onSelect} />
      </aside>
    </div>
  );
}

/** Pretty-print a dump value to JSON, falling back to String() if not serializable. */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function DumpBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const label = typeof record.label === 'string' ? record.label : null;
  return (
    <div>
      {label ? <h3 className="mb-2 font-mono text-sm text-fuchsia-400">{label}</h3> : null}
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
        {prettyJson(record.value)}
      </pre>
    </div>
  );
}

/** Tailwind text color for a log level badge. */
function logLevelColor(level: string): string {
  switch (level) {
    case 'error':
      return 'text-red-400';
    case 'warn':
      return 'text-amber-400';
    case 'debug':
    case 'verbose':
      return 'text-zinc-500';
    default:
      return 'text-zinc-300';
  }
}

function EventBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : String(record.name ?? '');
  const listenerCount = typeof record.listenerCount === 'number' ? record.listenerCount : null;
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 font-mono text-sm text-indigo-400">
        {name}
        {listenerCount !== null ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {listenerCount} listener{listenerCount === 1 ? '' : 's'}
          </span>
        ) : null}
      </h3>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
        {prettyJson(record.payload)}
      </pre>
    </div>
  );
}

/** Tailwind text color for a model action badge. */
function modelActionColor(action: string): string {
  switch (action) {
    case 'create':
      return 'text-emerald-400';
    case 'update':
      return 'text-amber-400';
    case 'delete':
      return 'text-red-400';
    default:
      return 'text-zinc-300';
  }
}

function ModelBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const action = typeof record.action === 'string' ? record.action : 'update';
  const entity = typeof record.entity === 'string' ? record.entity : String(record.entity ?? '');
  const id = record.id === null || record.id === undefined ? null : String(record.id);
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 font-mono text-sm text-lime-400">
        <span
          className={`rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase ${modelActionColor(action)}`}
        >
          {action}
        </span>
        <span>{entity}</span>
        {id !== null ? <span className="text-zinc-500">#{id}</span> : null}
      </h3>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
        {prettyJson(record.changes)}
      </pre>
    </div>
  );
}

function RedisBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const command =
    typeof record.command === 'string' ? record.command : String(record.command ?? '');
  const durationMs = typeof record.durationMs === 'number' ? record.durationMs : null;
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 font-mono text-sm text-rose-400">
        {command}
        {durationMs !== null ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {durationMs} ms
          </span>
        ) : null}
      </h3>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
        {prettyJson(record.args)}
      </pre>
    </div>
  );
}

function LogBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const level = typeof record.level === 'string' ? record.level : 'log';
  const message =
    typeof record.message === 'string' ? record.message : String(record.message ?? '');
  const context = typeof record.context === 'string' ? record.context : null;
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm">
        <span
          className={`rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase ${logLevelColor(level)}`}
        >
          {level}
        </span>
        {context ? <span className="font-mono text-xs text-zinc-500">{context}</span> : null}
      </h3>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">{message}</pre>
    </div>
  );
}

function TraceRow({
  traceId,
  spanId,
  traceLink,
}: { traceId: string; spanId: string | null; traceLink: string | null }): JSX.Element {
  const href = buildTraceHref(traceLink, traceId, spanId ?? '');
  return (
    <div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[11px] text-emerald-400 hover:underline"
        >
          {traceId}
        </a>
      ) : (
        <div className="font-mono text-[11px] text-zinc-300">{traceId}</div>
      )}
      {spanId ? <div className="font-mono text-[10px] text-zinc-500">{spanId}</div> : null}
      <a
        href={`#/traces/${traceId}`}
        className="mt-1 inline-block text-[11px] text-emerald-400 hover:underline"
      >
        View all in this trace
      </a>
    </div>
  );
}
