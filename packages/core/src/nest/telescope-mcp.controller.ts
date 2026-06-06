// packages/core/src/nest/telescope-mcp.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  MethodNotAllowedException,
  Post,
  Req,
} from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import { EntryType } from '../entry/entry.js';
import type { Entry } from '../entry/entry.js';
import { PulseService } from '../pulse/pulse.service.js';
import type { EntryQuery, StorageProvider } from '../storage/storage-provider.js';
import { TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

const PROTOCOL_VERSION = '2025-06-18';
const STATS_WINDOW = '1h';
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** Tool catalogue mirrored from the sibling adonis-telescope MCP server. */
const TOOLS = [
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
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

interface ToolArgs {
  type?: string;
  search?: string;
  tag?: string;
  sinceMinutes?: number;
  limit?: number;
  id?: string;
  batchId?: string;
}

/**
 * MCP (Model Context Protocol) server — stateless JSON-RPC over streamable HTTP —
 * so coding agents (Claude Code, Cursor, …) can debug straight from the captured
 * data: "why is POST /checkout slow?" → the agent pulls the batch waterfall with
 * every query. Hand-rolled JSON-RPC (no SDK dependency), backed by the same
 * storage / pulse / diagnosis APIs as the dashboard.
 *
 * Auth is a Bearer token (`mcp: { token }`); without one the endpoint is allowed
 * only when `NODE_ENV !== 'production'`. Carries NO `@UseGuards(TelescopeGuard)`:
 * the cookie-session dashboard gate doesn't apply to a header-only agent client,
 * so this controller enforces its own Bearer check. NestJS has no CSRF guard by
 * default, so there is nothing CSRF-like to bypass.
 */
@Controller()
export class TelescopeMcpController {
  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Inject(PulseService) private readonly pulse: PulseService,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
  ) {}

  // The MCP streamable-HTTP transport opens a GET stream for server→client
  // notifications; this stateless server has none, so 405 (per the spec).
  @Get()
  getStream(): never {
    throw new MethodNotAllowedException('MCP server is stateless; GET is not supported.');
  }

  // DELETE terminates a session; this stateless server holds none, so 200 (no-op).
  @Delete()
  @HttpCode(200)
  deleteSession(): { ok: true } {
    return { ok: true };
  }

  @Post()
  @HttpCode(200)
  async rpc(@Req() request: unknown, @Body() body: JsonRpcRequest): Promise<unknown> {
    if (!this.isAuthorized(request)) {
      // JSON-RPC has no transport-level 401; surface the denial as an RPC error
      // with the conventional id echo so a compliant client can read it.
      return this.fail(body?.id, -32001, 'Unauthorized: a valid Bearer token is required.');
    }
    return this.handle(body);
  }

  /**
   * Bearer-token gate. With a configured token, the request MUST carry a matching
   * `Authorization: Bearer <token>` header. Without a token, allow only when
   * `NODE_ENV !== 'production'` (mirroring the default-open-in-dev dashboard
   * authorizer); a tokenless config in production is refused.
   */
  private isAuthorized(request: unknown): boolean {
    const token = this.configuredToken();
    if (token === null) {
      return process.env.NODE_ENV !== 'production';
    }
    const header = readAuthorizationHeader(request);
    if (header === null) return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match !== null && match[1] === token;
  }

  /** The configured Bearer token, or `null` when `mcp` is `true`/disabled. */
  private configuredToken(): string | null {
    const mcp = this.options.mcp;
    if (mcp === undefined || mcp === false || mcp === true) return null;
    return mcp.token ?? null;
  }

  private async handle(body: JsonRpcRequest): Promise<unknown> {
    const { id, method, params } = body ?? {};
    try {
      switch (method) {
        case 'initialize':
          return this.respond(id, {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'nestjs-telescope', version: '0.0.0' },
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          // Notifications (no id) get no response body.
          return null;
        case 'ping':
          return this.respond(id, {});
        case 'tools/list':
          return this.respond(id, { tools: TOOLS });
        case 'tools/call': {
          const text = await this.callTool(params?.name, (params?.arguments ?? {}) as ToolArgs);
          return this.respond(id, { content: [{ type: 'text', text }] });
        }
        default:
          return this.fail(id, -32601, `Method not found: ${String(method)}`);
      }
    } catch (error: unknown) {
      return this.fail(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private respond(id: JsonRpcRequest['id'], result: unknown): unknown {
    return id === undefined || id === null ? null : { jsonrpc: '2.0', id, result };
  }

  private fail(id: JsonRpcRequest['id'], code: number, message: string): unknown {
    return id === undefined || id === null
      ? null
      : { jsonrpc: '2.0', id, error: { code, message } };
  }

  private async callTool(name: string | undefined, args: ToolArgs): Promise<string> {
    switch (name) {
      case 'list_entries': {
        const query: EntryQuery = {
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(args.search !== undefined && args.search !== '' ? { search: args.search } : {}),
          ...(args.tag !== undefined ? { tag: args.tag } : {}),
          ...(typeof args.sinceMinutes === 'number'
            ? { after: new Date(Date.now() - args.sinceMinutes * 60_000) }
            : {}),
          limit: clampLimit(args.limit),
        };
        const page = await this.storage.get(query);
        return JSON.stringify({ entries: page.data.map(slim) }, null, 2);
      }
      case 'get_entry': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        const entry = await this.storage.find(args.id);
        if (!entry) return 'Entry not found (it may have been pruned).';
        const { batch, ...rest } = entry;
        return JSON.stringify({ entry: rest, batch: batch.map(slim) }, null, 2);
      }
      case 'get_batch': {
        if (typeof args.batchId !== 'string') throw new Error('`batchId` is required.');
        const batch = await this.storage.batch(args.batchId);
        if (batch.length === 0) return 'Batch not found.';
        return JSON.stringify({ entries: batch }, null, 2);
      }
      case 'get_stats': {
        const stats = await this.pulse.getHealth(durationToMs(STATS_WINDOW));
        return JSON.stringify(stats, null, 2);
      }
      case 'diagnose_exception': {
        if (typeof args.id !== 'string') throw new Error('`id` is required.');
        const coordinator = this.service.diagnosisCoordinator;
        if (coordinator === null) return 'AI diagnosis is not configured on this telescope.';
        const entry = await this.storage.find(args.id);
        if (
          entry === null ||
          (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException)
        ) {
          return 'No exception entry with that id.';
        }
        const result = await coordinator.diagnose(entry, 1, false);
        return result.markdown;
      }
      default:
        throw new Error(`Unknown tool: ${String(name)}`);
    }
  }
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

/** Read the `Authorization` header off an Express/Fastify request, or `null`. */
function readAuthorizationHeader(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const headers = (request as { headers?: unknown }).headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const value = (headers as Record<string, unknown>).authorization;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}
