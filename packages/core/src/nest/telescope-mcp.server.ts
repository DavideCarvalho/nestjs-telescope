// packages/core/src/nest/telescope-mcp.server.ts
import { durationToMs } from '../config/parse-duration.js';
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';
import { buildWaterfall } from '../metrics/waterfall.js';
import type { PulseService } from '../pulse/pulse.service.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import type { TelescopeService } from './telescope.service.js';

const STATS_WINDOW = '1h';
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
/** Entries one trace returns at most (the dashboard's waterfall reads the same amount). */
const TRACE_LIMIT = 500;
const DEFAULT_HEALTH_MINUTES = 60;

/** One tool of the MCP catalogue. */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: readonly string[];
  };
}

/** The tool catalogue `POST <path>/api/mcp` lists. */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'list_entries',
    description:
      'List recent telescope entries (requests, queries, exceptions, jobs, logs, etc). Filter by type, full-text search, tag or time window. Returns newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Entry type: request, query, exception, client_exception, log, event, mail, job, model, cache, http_client, redis, dump…',
        },
        search: { type: 'string', description: 'Full-text search inside entry content' },
        tag: { type: 'string', description: 'Exact tag match, e.g. "status:500" or "slow"' },
        sinceMinutes: { type: 'number', description: 'Only entries from the last N minutes' },
        limit: { type: 'number', description: 'Max entries (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_entry',
    description:
      'Get one entry by id with its full batch — every other entry recorded during the same request/job (queries, logs, renders…), i.e. the waterfall.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Entry id' } },
      required: ['id'],
    },
  },
  {
    name: 'get_batch',
    description: 'Get every entry of a batch (one request/job execution) ordered by sequence.',
    inputSchema: {
      type: 'object',
      properties: { batchId: { type: 'string', description: 'Batch id' } },
      required: ['batchId'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Aggregate health snapshot of the last hour: request throughput + percentiles, slowest requests and queries, N+1 suspects, exception families, per-route aggregates, cache hit rate, telescope health.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'diagnose_exception',
    description:
      'Run the AI diagnosis on an exception entry (probable cause, where to look, suggested fix). Only available when AI is configured.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Exception entry id' } },
      required: ['id'],
    },
  },
];

/** The arguments the tools read (a superset; each tool picks its own). */
export interface McpToolArgs {
  type?: string;
  search?: string;
  tag?: string;
  sinceMinutes?: number;
  limit?: number;
  cursor?: string;
  id?: string;
  batchId?: string;
  traceId?: string;
}

/** A "nothing to show" answer (an unknown or pruned id, no AI configured). */
export interface McpToolNotice {
  notice: string;
}

/** Whether a {@link TelescopeMcpServer.call} result is a {@link McpToolNotice}. */
export function isMcpToolNotice(value: unknown): value is McpToolNotice {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { notice?: unknown }).notice === 'string'
  );
}

const notice = (text: string): McpToolNotice => ({ notice: text });

/**
 * Telescope's MCP tools over the stored (already redacted) entries: what `POST <path>/api/mcp`
 * answers, and what the Aviary dev-tools endpoint serves as `telescope_*`.
 */
export class TelescopeMcpServer {
  constructor(
    private readonly storage: StorageProvider,
    private readonly service: TelescopeService,
    private readonly pulse: PulseService,
  ) {}

  /**
   * Runs one tool and returns its structured result: a string (a diagnosis' markdown), an object,
   * or a {@link McpToolNotice} when there is nothing to show. Throws on bad input or an unknown
   * tool. Besides {@link MCP_TOOLS} it answers `get_trace`, `get_waterfall` and `get_health`.
   */
  async call(name: string | undefined, args: McpToolArgs = {}): Promise<unknown> {
    switch (name) {
      case 'list_entries': {
        const page = await this.storage.get(listQuery(args));
        return { entries: page.data.map(slim), ...(page.partial ? { partial: true } : {}) };
      }
      case 'get_entry': {
        const id = required(args, 'id');
        const entry = await this.storage.find(id);
        if (!entry) return notice('Entry not found (it may have been pruned).');
        const { batch, ...rest } = entry;
        return { entry: rest, batch: batch.map(slim) };
      }
      case 'get_batch': {
        const batch = await this.storage.batch(required(args, 'batchId'));
        if (batch.length === 0) return notice('Batch not found.');
        return { entries: batch };
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
      case 'get_stats':
        return this.pulse.getHealth(durationToMs(STATS_WINDOW));
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
    args: McpToolArgs = {},
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

function required(args: McpToolArgs, key: 'id' | 'batchId' | 'traceId'): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`\`${key}\` is required.`);
  return value;
}

function listQuery(args: McpToolArgs): EntryQuery {
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

/** Compact projection for list payloads — agents drill in via get_entry. */
function slim(entry: Entry): Record<string, unknown> {
  const c = (entry.content ?? {}) as Record<string, unknown>;
  let summary: string;
  switch (entry.type) {
    case EntryType.Request:
      summary = `${String(c.method)} ${String(c.uri)} → ${String(c.statusCode)}`;
      break;
    case EntryType.Query:
      summary = String(c.sql ?? '').slice(0, 200);
      break;
    case EntryType.Exception:
    case EntryType.ClientException:
      summary = `${String(c.class ?? c.name)}: ${String(c.message)}`;
      break;
    case EntryType.Log:
      summary = `${String(c.level)}: ${String(c.message)}`;
      break;
    case EntryType.Job:
      summary = `${String(c.name)} (${String(c.status)})`;
      break;
    default:
      summary = safeSummary(c, entry.type);
  }
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
