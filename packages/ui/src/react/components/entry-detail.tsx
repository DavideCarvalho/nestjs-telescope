import { useState } from 'react';
import type { DiagnoseResult, EntryWithBatch } from '../../client/index.js';
import { useCachedDiagnosis, useDiagnose, useExplain, useMeta } from '../use-telescope-queries.js';
import { BatchTimeline } from './batch-timeline.js';
import { CacheBadge } from './cache-badge.js';
import { ExportJsonToolbar } from './export-json-toolbar.js';
import { RequestTimeline } from './request-timeline.js';
import { buildTraceHref } from './trace-link.js';
import { buildUserActivityHref, findUserTag, userTagId } from './user-tag.js';

export function EntryDetail({
  entry,
  onSelect,
}: { entry: EntryWithBatch; onSelect?: (id: string) => void }): JSX.Element {
  const { data: meta } = useMeta();
  const showTimeline = entry.type === 'request' && entry.batch.length > 1;
  const userTag = findUserTag(entry.tags);
  return (
    <div className="grid grid-cols-3 gap-6">
      <section className="col-span-2">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm text-emerald-400">
            {entry.type}
            {entry.type === 'cache' ? <CacheBadge content={entry.content} /> : null}
          </h2>
          <ExportJsonToolbar value={entry} filename={`telescope-entry-${entry.id}.json`} />
        </div>
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
        ) : entry.type === 'client_exception' ? (
          <>
            <ClientExceptionBody content={entry.content} />
            <DiagnosePanel entryId={entry.id} aiEnabled={meta?.ai?.enabled ?? false} />
          </>
        ) : entry.type === 'exception' ? (
          <>
            <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
              {JSON.stringify(entry.content, null, 2)}
            </pre>
            <DiagnosePanel entryId={entry.id} aiEnabled={meta?.ai?.enabled ?? false} />
          </>
        ) : entry.type === 'request' ? (
          <RequestBody content={entry.content} />
        ) : entry.type === 'query' ? (
          <QueryBody
            entryId={entry.id}
            content={entry.content}
            explainEnabled={meta?.explainEnabled ?? false}
          />
        ) : (
          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
            {JSON.stringify(entry.content, null, 2)}
          </pre>
        )}
      </section>
      <aside>
        {userTag !== null ? (
          <div className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">User</h3>
            <div className="font-mono text-[11px] text-zinc-300">{userTagId(userTag)}</div>
            <a
              href={buildUserActivityHref(userTag)}
              className="mt-1 inline-block text-[11px] text-emerald-400 hover:underline"
            >
              View all activity for this user
            </a>
          </div>
        ) : null}
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

/**
 * A labelled monospace block for a stack / component-stack string. Rendered only
 * when there's something to show, so an error without a stack doesn't leave an
 * empty fence. The orange accent matches the `client_exception` type dot.
 */
function StackBlock({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-4">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{label}</h3>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-300">
        {value}
      </pre>
    </div>
  );
}

/**
 * Renders a browser-reported `client_exception`: the name + message header,
 * page URL and user-agent, then the JS stack and (when present) the React
 * component stack, followed by any host-supplied `extra` debugging context.
 * Reads every field defensively — the content originated from an UNTRUSTED
 * browser, so nothing is assumed beyond `message`.
 */
function ClientExceptionBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const name = typeof record.name === 'string' ? record.name : null;
  const message =
    typeof record.message === 'string' ? record.message : String(record.message ?? '');
  const url = typeof record.url === 'string' ? record.url : null;
  const userAgent = typeof record.userAgent === 'string' ? record.userAgent : null;
  const release = typeof record.release === 'string' ? record.release : null;
  const stack = typeof record.stack === 'string' ? record.stack : null;
  const componentStack = typeof record.componentStack === 'string' ? record.componentStack : null;
  return (
    <div>
      <h3 className="mb-3 flex flex-wrap items-center gap-2 font-mono text-sm text-orange-400">
        {name ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase">{name}</span>
        ) : null}
        <span className="text-zinc-300">{message}</span>
        {release ? <span className="text-[10px] text-zinc-500">{release}</span> : null}
      </h3>
      {url ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">URL</h3>
          <div className="break-all font-mono text-xs text-zinc-300">{url}</div>
        </div>
      ) : null}
      {userAgent ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">User agent</h3>
          <div className="break-all font-mono text-[11px] text-zinc-400">{userAgent}</div>
        </div>
      ) : null}
      {stack ? <StackBlock label="Stack" value={stack} /> : null}
      {componentStack ? <StackBlock label="Component stack" value={componentStack} /> : null}
      {hasContent(record.extra) ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Extra</h3>
          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
            {prettyJson(record.extra)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** True when a value is a non-null object or non-empty array (worth rendering). */
function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function RequestHeaders({ headers }: { headers: Record<string, unknown> }): JSX.Element {
  const entries = Object.entries(headers);
  return (
    <details className="mb-4">
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-500">
        Headers ({entries.length})
      </summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded bg-zinc-900 p-3 text-xs">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="font-mono text-zinc-500">{key}</dt>
            <dd className="break-all font-mono text-zinc-300">
              {typeof value === 'string' ? value : prettyJson(value)}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function RequestBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const headers =
    typeof record.headers === 'object' && record.headers !== null
      ? (record.headers as Record<string, unknown>)
      : {};
  const method = typeof record.method === 'string' ? record.method : String(record.method ?? '');
  const uri = typeof record.uri === 'string' ? record.uri : String(record.uri ?? '');
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : null;
  const ip = typeof record.ip === 'string' ? record.ip : null;
  const hasUser = 'user' in record && record.user !== null && record.user !== undefined;
  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 font-mono text-sm text-emerald-400">
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase">{method}</span>
        <span className="text-zinc-300">{uri}</span>
        {statusCode !== null ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">
            {statusCode}
          </span>
        ) : null}
        {ip ? <span className="text-[10px] text-zinc-500">{ip}</span> : null}
      </h3>
      <RequestHeaders headers={headers} />
      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Payload</h3>
      {hasContent(record.payload) ? (
        <pre className="mb-4 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
          {prettyJson(record.payload)}
        </pre>
      ) : (
        <p className="mb-4 text-xs text-zinc-600">No payload</p>
      )}
      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">User</h3>
      {hasUser ? (
        <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
          {prettyJson(record.user)}
        </pre>
      ) : (
        <p className="text-xs text-zinc-600">anonymous</p>
      )}
    </div>
  );
}

function QueryBody({
  entryId,
  content,
  explainEnabled,
}: { entryId: string; content: unknown; explainEnabled: boolean }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};
  const sql = typeof record.sql === 'string' ? record.sql : String(record.sql ?? '');
  const slow = record.slow === true;
  const explain = useExplain();
  const result = explain.data;

  async function onExplain(): Promise<void> {
    try {
      await explain.mutateAsync(entryId);
    } catch {
      // mutateAsync rejects only on transport errors; the client maps the
      // expected 404/503 outcomes into a non-throwing `{ ok: false }` result.
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-mono text-sm text-sky-400">
          query
          {slow ? (
            <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-amber-400">
              slow
            </span>
          ) : null}
        </h3>
        {explainEnabled ? (
          <button
            type="button"
            onClick={onExplain}
            disabled={explain.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {explain.isPending ? 'Explaining…' : 'Explain'}
          </button>
        ) : null}
      </div>
      <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">{sql}</pre>
      {Array.isArray(record.bindings) && record.bindings.length > 0 ? (
        <>
          <h3 className="mt-3 mb-2 text-xs uppercase tracking-wide text-zinc-500">Bindings</h3>
          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
            {prettyJson(record.bindings)}
          </pre>
        </>
      ) : null}
      {explain.isPending ? (
        <p className="mt-3 text-xs text-zinc-600">Running EXPLAIN…</p>
      ) : result === undefined ? null : result.ok ? (
        <>
          <h3 className="mt-3 mb-2 text-xs uppercase tracking-wide text-zinc-500">Query plan</h3>
          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
            {prettyJson(result.plan)}
          </pre>
        </>
      ) : (
        <p className="mt-3 rounded bg-zinc-900 p-3 text-xs text-red-400">{result.message}</p>
      )}
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

/**
 * "AI diagnosis" panel for exception / client_exception details. Visible only
 * when `meta.ai.enabled` (the host configured a diagnoser).
 *
 * On mount it READS any already-cached diagnosis via the side-effect-free
 * `GET /exceptions/:id/diagnosis` (`useCachedDiagnosis`, gated on `aiEnabled`).
 * This is what makes an AUTO-MODE diagnosis — computed and cached at first-seen,
 * and possibly already sent to Slack — appear immediately on open instead of a
 * bare "Diagnose with AI" button. If nothing is cached, the button is shown so an
 * operator can diagnose on demand; once a diagnosis exists (cached or freshly
 * run) a "Re-run" (force) action replaces it and a "cached" badge is shown.
 *
 * The on-demand `diagnose` mutation rejects only on transport errors — the client
 * maps the expected 404/502 outcomes into a non-throwing `{ ok: false }` result —
 * so the click handler swallows the rejection and renders the outcome. A freshly
 * run result (`result`) takes precedence over the mount-fetched cached one.
 *
 * Loading is kept subtle: while the GET is in flight we show a quiet "Checking…"
 * line rather than flashing the button and then swapping it for a result.
 */
function DiagnosePanel({
  entryId,
  aiEnabled,
}: { entryId: string; aiEnabled: boolean }): JSX.Element | null {
  const diagnose = useDiagnose();
  // Gated on `aiEnabled`: when AI is off we never fetch (the panel also returns
  // null below, but the hook must be called unconditionally to respect the
  // rules-of-hooks, hence the `enabled` flag rather than an early-return guard).
  const cachedQuery = useCachedDiagnosis(entryId, aiEnabled);
  const [result, setResult] = useState<DiagnoseResult | null>(null);

  if (!aiEnabled) return null;

  async function run(force: boolean): Promise<void> {
    try {
      const next = await diagnose.mutateAsync({ entryId, force });
      setResult(next);
    } catch {
      // Transport-level failure; the client maps API 404/502 to { ok: false }.
      setResult({ ok: false, message: 'Diagnosis request failed.' });
    }
  }

  // A freshly run result wins; otherwise fall back to the mount-fetched cache.
  const cachedHit = cachedQuery.data ?? null;
  const ranResult = result;
  const isCached =
    ranResult !== null ? ranResult.ok === true && ranResult.cached : cachedHit !== null;
  const hasResult = ranResult !== null ? ranResult.ok === true : cachedHit !== null;
  // Subtle initial-load state: still resolving the cache lookup and the user
  // hasn't clicked yet. Avoids flashing the button before a cached result lands.
  const checkingCache = ranResult === null && cachedQuery.isLoading;

  return (
    <div className="mt-4 rounded border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
          AI diagnosis
          {isCached ? (
            <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] normal-case text-amber-400">
              cached
            </span>
          ) : null}
        </h3>
        <div className="flex items-center gap-2">
          {checkingCache ? null : hasResult ? (
            <button
              type="button"
              onClick={() => run(true)}
              disabled={diagnose.isPending}
              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {diagnose.isPending ? 'Re-running…' : 'Re-run'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => run(false)}
              disabled={diagnose.isPending}
              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-emerald-400 hover:border-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {diagnose.isPending ? 'Diagnosing…' : 'Diagnose with AI'}
            </button>
          )}
        </div>
      </div>
      {diagnose.isPending ? (
        <p className="text-xs text-zinc-600">Asking the model…</p>
      ) : checkingCache ? (
        <p className="text-xs text-zinc-600">Checking for an existing diagnosis…</p>
      ) : ranResult !== null ? (
        ranResult.ok ? (
          <Markdown source={ranResult.markdown} />
        ) : (
          <p className="rounded bg-zinc-900 p-3 text-xs text-red-400">{ranResult.message}</p>
        )
      ) : cachedHit !== null ? (
        <Markdown source={cachedHit.markdown} />
      ) : (
        <p className="text-xs text-zinc-600">
          Get an AI-generated probable cause, where to look, and a suggested fix.
        </p>
      )}
    </div>
  );
}

/**
 * Lightweight markdown renderer. The UI deps carry NO markdown library, and the
 * diagnosis output is a small, fixed-shape document (`## ` headings + paragraphs/
 * bullets), so rather than add a heavy dependency we render it as styled
 * preformatted sections: `## ` lines become headings, `- ` lines become bullets,
 * and everything else is preformatted text. Inline emphasis is left as-is (the
 * monospace block keeps it readable).
 */
type MarkdownBlock =
  | { id: string; kind: 'heading'; text: string }
  | { id: string; kind: 'paragraph'; text: string }
  | { id: string; kind: 'bullets'; items: { id: string; text: string }[] };

/** Parse the (small, fixed-shape) markdown into a typed block list with stable
 *  keys, so rendering never relies on array indices as React keys. */
function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let bullets: { id: string; text: string }[] = [];
  let counter = 0;
  const nextId = (): string => `block-${counter++}`;

  function flushParagraph(): void {
    if (paragraph.length === 0) return;
    blocks.push({ id: nextId(), kind: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  }
  function flushBullets(): void {
    if (bullets.length === 0) return;
    blocks.push({ id: nextId(), kind: 'bullets', items: bullets });
    bullets = [];
  }

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      flushBullets();
      blocks.push({ id: nextId(), kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') });
    } else if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      bullets.push({ id: nextId(), text: line.replace(/^[-*]\s+/, '') });
    } else if (line.trim() === '') {
      flushParagraph();
      flushBullets();
    } else {
      flushBullets();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushBullets();
  return blocks;
}

function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className="rounded bg-zinc-900 p-3">
      {blocks.map((block) => {
        if (block.kind === 'heading') {
          return (
            <h4 key={block.id} className="mt-3 mb-1 text-xs font-semibold text-emerald-400">
              {block.text}
            </h4>
          );
        }
        if (block.kind === 'bullets') {
          return (
            <ul key={block.id} className="ml-4 list-disc text-xs leading-relaxed text-zinc-300">
              {block.items.map((item) => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={block.id} className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
