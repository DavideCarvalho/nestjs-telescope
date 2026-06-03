import type { Entry } from '../../client/index.js';
import { CacheBadge } from './cache-badge.js';

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
    if (typeof record.message === 'string') return record.message;
    if (typeof record.url === 'string') {
      return typeof record.method === 'string' ? `${record.method} ${record.url}` : record.url;
    }
  }
  return entry.type;
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
        {entries.map((entry) => (
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
                {entry.tags.length > 0 && <span>{entry.tags.join(' ')}</span>}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
