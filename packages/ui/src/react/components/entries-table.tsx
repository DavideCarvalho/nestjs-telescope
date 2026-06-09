import type { Entry } from '../../client/index.js';
import { CacheBadge } from './cache-badge.js';
import { InertiaBadge } from './inertia-badge.js';
import { buildUserActivityHref, findUserTag, userTagId } from './user-tag.js';

export function entryLabel(entry: Entry): string {
  const content = entry.content;
  if (typeof content === 'object' && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.uri === 'string') {
      return typeof record.method === 'string' ? `${record.method} ${record.uri}` : record.uri;
    }
    if (typeof record.sql === 'string') return record.sql;
    if (typeof record.queue === 'string' && typeof record.name === 'string') {
      return `${record.queue}:${record.name}`;
    }
    if (entry.type === 'dump') {
      if (typeof record.label === 'string' && record.label.length > 0) return record.label;
      return dumpValuePreview(record.value);
    }
    if (entry.type === 'event' && typeof record.name === 'string') return record.name;
    if (entry.type === 'model' && typeof record.action === 'string') {
      const entity = typeof record.entity === 'string' ? record.entity : '';
      const id = record.id === null || record.id === undefined ? '' : `#${String(record.id)}`;
      return `${record.action} ${entity}${id}`;
    }
    if (entry.type === 'redis' && typeof record.command === 'string') {
      return `${record.command} ${redisArgsPreview(record.args)}`.trim();
    }
    if (entry.type === 'inertia' && typeof record.component === 'string') {
      const method = typeof record.method === 'string' ? record.method : '';
      const partial = record.isPartial === true ? ' (partial)' : '';
      return `${method} → ${record.component}${partial}`.trim();
    }
    if (entry.type === 'log' && typeof record.message === 'string') {
      const level = typeof record.level === 'string' ? record.level : 'log';
      return `[${level}] ${record.message}`;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.url === 'string') {
      return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
    }
  }
  return entry.type;
}

/** A short, single-line preview of redis command args for table summaries. */
export function redisArgsPreview(args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return '';
  const text = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** A short, single-line preview of a dump value for table summaries. */
export function dumpValuePreview(value: unknown): string {
  if (typeof value === 'string') return value;
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function EntriesTable({
  entries,
  onSelect,
}: { entries: Entry[]; onSelect?: (id: string) => void }): JSX.Element {
  return (
    <table className="w-full text-left text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-2 font-normal">Time</th>
          <th className="font-normal">Type</th>
          <th className="font-normal">Summary</th>
          <th className="font-normal">Duration</th>
          <th className="font-normal">Tags</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const userTag = findUserTag(entry.tags);
          const otherTags = entry.tags.filter((tag) => tag !== userTag);
          return (
            <tr
              key={entry.id}
              onClick={() => onSelect?.(entry.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect?.(entry.id);
              }}
              className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
            >
              <td className="py-1.5 text-zinc-500">
                {new Date(entry.createdAt).toLocaleTimeString()}
              </td>
              <td className="text-emerald-400">{entry.type}</td>
              <td className="max-w-md truncate text-zinc-300">
                <span className="inline-flex items-center gap-1.5">
                  {entry.type === 'cache' ? <CacheBadge content={entry.content} /> : null}
                  {entry.type === 'inertia' ? <InertiaBadge content={entry.content} /> : null}
                  <span className="truncate">{entryLabel(entry)}</span>
                </span>
              </td>
              <td className="text-zinc-400">
                {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
              </td>
              <td className="text-zinc-600">
                <span className="inline-flex items-center gap-1.5">
                  {entry.traceId !== null && (
                    <a
                      href={`#/traces/${entry.traceId}`}
                      title={`View trace ${entry.traceId}`}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-sky-400 hover:bg-zinc-800"
                    >
                      trace:{entry.traceId.slice(0, 6)}
                    </a>
                  )}
                  {userTag !== null && (
                    <a
                      href={buildUserActivityHref(userTag)}
                      title={`View all activity for user ${userTagId(userTag)}`}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400 hover:bg-zinc-800"
                    >
                      {userTag}
                    </a>
                  )}
                  {otherTags.length > 0 && <span>{otherTags.join(' ')}</span>}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
