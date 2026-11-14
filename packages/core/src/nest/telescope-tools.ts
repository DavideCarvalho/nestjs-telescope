// packages/core/src/nest/telescope-tools.ts
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';
import { buildWaterfall } from '../metrics/waterfall.js';
import type { PulseService } from '../pulse/pulse.service.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import type { TelescopeService } from './telescope.service.js';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
/** Entries one trace returns at most (the dashboard's waterfall reads the same amount). */
const TRACE_LIMIT = 500;
const DEFAULT_HEALTH_MINUTES = 60;

/** The arguments the tools read (a superset; each tool picks its own). */
export interface TelescopeToolArgs {
  type?: string;
  search?: string;
  tag?: string;
  sinceMinutes?: number;
  limit?: number;
  cursor?: string;
  id?: string;
  traceId?: string;
}

/** A "nothing to show" answer (an unknown or pruned id, no AI configured). */
export interface TelescopeToolNotice {
  notice: string;
}

/** Whether a {@link TelescopeTools.call} result is a {@link TelescopeToolNotice}. */
export function isToolNotice(value: unknown): value is TelescopeToolNotice {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { notice?: unknown }).notice === 'string'
  );
}

const notice = (text: string): TelescopeToolNotice => ({ notice: text });

/**
 * What telescope's `telescope_*` tools on the Aviary dev MCP endpoint (`/mcp/aviary`) run, over
 * the stored (already redacted) entries. Internal: not exported from the package.
 */
export class TelescopeTools {
  constructor(
    private readonly storage: StorageProvider,
    private readonly service: TelescopeService,
    private readonly pulse: PulseService,
  ) {}

  /**
   * Runs one tool and returns its structured result: a string (a diagnosis' markdown), an object,
   * or a {@link TelescopeToolNotice} when there is nothing to show. Throws on bad input or an
   * unknown tool: `get_entry`, `get_trace`, `get_waterfall`, `get_health`, `diagnose_exception`.
   */
  async call(name: string | undefined, args: TelescopeToolArgs = {}): Promise<unknown> {
    switch (name) {
      case 'get_entry': {
        const id = required(args, 'id');
        const entry = await this.storage.find(id);
        if (!entry) return notice('Entry not found (it may have been pruned).');
        const { batch, ...rest } = entry;
        return { entry: rest, batch: batch.map(slim) };
      }
      case 'get_trace': {
        const page = await this.storage.get({
          traceId: required(args, 'traceId'),
          limit: TRACE_LIMIT,
        });
        if (page.data.length === 0) return notice('Trace not found (it may have been pruned).');
        return { entries: page.data };
      }
      case 'get_waterfall': {
        const page = await this.storage.get({
          traceId: required(args, 'traceId'),
          limit: TRACE_LIMIT,
        });
        return buildWaterfall(page.data) ?? notice('Trace not found (it may have been pruned).');
      }
      case 'get_health': {
        const minutes =
          typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0
            ? args.sinceMinutes
            : DEFAULT_HEALTH_MINUTES;
        return this.pulse.getHealth(minutes * 60_000);
      }
      case 'diagnose_exception': {
        const id = required(args, 'id');
        const coordinator = this.service.diagnosisCoordinator;
        if (coordinator === null)
          return notice('AI diagnosis is not configured on this telescope.');
        const entry = await this.storage.find(id);
        if (
          entry === null ||
          (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
        ) {
          return notice('No exception entry with that id.');
        }
        const result = await coordinator.diagnose(entry, 1, false);
        return result.markdown;
      }
      default:
        throw new Error(`Unknown tool: ${String(name)}`);
    }
  }

  /**
   * One page of entries as compact summaries, newest first: `{ items, next }`, `next` being the
   * cursor of the following page (or `null`).
   */
  async listEntries(
    args: TelescopeToolArgs = {},
  ): Promise<{ items: Record<string, unknown>[]; next: string | null; partial?: true }> {
    const page = await this.storage.get(listQuery(args));
    return {
      items: page.data.map(slim),
      next: page.nextCursor,
      ...(page.partial ? { partial: true as const } : {}),
    };
  }

  /** Whether `diagnose_exception` has an AI coordinator behind it. */
  canDiagnose(): boolean {
    return this.service.diagnosisCoordinator !== null;
  }
}

function required(args: TelescopeToolArgs, key: 'id' | 'traceId'): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`\`${key}\` is required.`);
  return value;
}

function listQuery(args: TelescopeToolArgs): EntryQuery {
  return {
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.search !== undefined && args.search !== '' ? { search: args.search } : {}),
    ...(args.tag !== undefined ? { tag: args.tag } : {}),
    ...(typeof args.sinceMinutes === 'number'
      ? { after: new Date(Date.now() - args.sinceMinutes * 60_000) }
      : {}),
    ...(typeof args.cursor === 'string' && args.cursor !== '' ? { cursor: args.cursor } : {}),
    limit: clampLimit(args.limit),
  };
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIST_LIMIT));
}

/** One line describing an entry: `GET /x → 200`, the SQL, `Error: message`… */
export function summarizeEntry(entry: Pick<Entry, 'type' | 'content'>): string {
  const c = (entry.content ?? {}) as Record<string, unknown>;
  switch (entry.type) {
    case EntryType.Request:
      return `${String(c.method)} ${String(c.uri)} → ${String(c.statusCode)}`;
    case EntryType.Query:
      return String(c.sql ?? '').slice(0, 200);
    case EntryType.Exception:
    case EntryType.ClientException:
      return `${String(c.class ?? c.name)}: ${String(c.message)}`;
    case EntryType.Log:
      return `${String(c.level)}: ${String(c.message)}`;
    case EntryType.Job:
      return `${String(c.name)} (${String(c.status)})`;
    default:
      return safeSummary(c, entry.type);
  }
}

/** Compact projection for list payloads — agents drill in via get_entry. */
function slim(entry: Entry): Record<string, unknown> {
  const summary = summarizeEntry(entry);
  return {
    id: entry.id,
    type: entry.type,
    batchId: entry.batchId,
    durationMs: entry.durationMs,
    createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : entry.createdAt,
    tags: entry.tags,
    summary,
  };
}

function safeSummary(content: Record<string, unknown>, type: string): string {
  try {
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return type;
  }
}
