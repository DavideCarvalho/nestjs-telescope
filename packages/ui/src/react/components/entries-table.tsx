import type { Entry } from '../../client/index.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/index.js';
import { CacheBadge } from './cache-badge.js';
import { dotForType } from './entry-types.js';
import { InertiaBadge } from './inertia-badge.js';
import { isOfficialEventType, officialEventLabel } from './official-event.js';
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
    if (isOfficialEventType(entry.type)) return officialEventLabel(entry.type, record);
    if (entry.type === 'mail' && typeof record.status === 'string') {
      const subject = typeof record.subject === 'string' ? record.subject : '(no subject)';
      return `[${record.status}] ${subject}`;
    }
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
}: { entries: Entry[]; onSelect?: (id: string) => void }): React.JSX.Element {
  return (
    <Table className="text-left">
      <TableHeader>
        <TableRow>
          <TableHead className="py-2.5 pr-3 pl-4">Time</TableHead>
          <TableHead className="px-3">Type</TableHead>
          <TableHead className="px-3">Summary</TableHead>
          <TableHead className="px-3 text-right">Duration</TableHead>
          <TableHead className="hidden pr-4 pl-3 md:table-cell">Tags</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => {
          const userTag = findUserTag(entry.tags);
          const otherTags = entry.tags.filter((tag) => tag !== userTag);
          return (
            <TableRow
              key={entry.id}
              onClick={() => onSelect?.(entry.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect?.(entry.id);
              }}
              className="cursor-pointer transition-colors hover:bg-hover"
            >
              <TableCell className="py-2 pr-3 pl-4 align-middle font-mono whitespace-nowrap tabular-nums text-faint">
                {new Date(entry.createdAt).toLocaleTimeString()}
              </TableCell>
              <TableCell className="px-3 py-2 align-middle whitespace-nowrap text-fg-2">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`size-[7px] shrink-0 rounded-full ${dotForType(entry.type)}`}
                    aria-hidden="true"
                  />
                  {entry.type}
                </span>
              </TableCell>
              <TableCell className="max-w-md truncate px-3 py-2 align-middle font-mono text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  {entry.type === 'cache' ? <CacheBadge content={entry.content} /> : null}
                  {entry.type === 'inertia' ? <InertiaBadge content={entry.content} /> : null}
                  <span className="truncate">{entryLabel(entry)}</span>
                </span>
              </TableCell>
              <TableCell className="px-3 py-2 text-right align-middle font-mono whitespace-nowrap tabular-nums text-fg-2">
                {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
              </TableCell>
              <TableCell className="hidden py-2 pr-4 pl-3 align-middle font-mono text-[11px] text-faint md:table-cell">
                <span className="inline-flex items-center gap-1.5">
                  {entry.traceId !== null && (
                    <a
                      href={`#/traces/${entry.traceId}`}
                      title={`View trace ${entry.traceId}`}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded border border-brand-border bg-brand-soft px-1.5 py-0.5 font-mono text-[10px] text-brand hover:bg-panel-2"
                    >
                      trace:{entry.traceId.slice(0, 6)}
                    </a>
                  )}
                  {userTag !== null && (
                    <a
                      href={buildUserActivityHref(userTag)}
                      title={`View all activity for user ${userTagId(userTag)}`}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded border border-good/25 bg-good/10 px-1.5 py-0.5 font-mono text-[10px] text-good hover:bg-good/15"
                    >
                      {userTag}
                    </a>
                  )}
                  {otherTags.length > 0 && <span>{otherTags.join(' ')}</span>}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
