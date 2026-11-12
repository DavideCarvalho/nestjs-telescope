// packages/core/src/nest/dev-tools.ts
import {
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type ConsoleDecide, resolveConsoleAuthorize } from './console-authorize.js';
import { type McpToolArgs, TelescopeMcpServer, isMcpToolNotice } from './telescope-mcp.server.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

// ── the dev-tools contract (v1), re-declared: this package never imports the agent's MCP server ──

/** The process-wide slot the Aviary dev MCP endpoint serves (`@dudousxd/nestjs-agent-mcp-server`). */
export const DEV_TOOLS_SLOT = Symbol.for('@dudousxd/aviary:dev-tools');

/** What a lib's `authorize` answers on the dev-tools endpoint. */
export type DevToolsDecision =
  | { allowed: true; caller?: string }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** A dev tool's input: an object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  context: ExecutionContext;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

/** One developer tool, as the dev-tools slot takes it. */
export interface TelescopeDevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call?: DevToolCall): Promise<unknown>;
}

interface DevToolsLib {
  lib: string;
  title: string;
  authorize(context: ExecutionContext): Promise<DevToolsDecision>;
  tools: TelescopeDevTool[];
}

interface DevToolsSlot {
  readonly version: 1;
  readonly libs: DevToolsLib[];
  register(lib: DevToolsLib): () => void;
}

/** The slot, created when absent (whoever loads first creates it). */
function devToolsSlot(): Partial<DevToolsSlot> {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[DEV_TOOLS_SLOT] as Partial<DevToolsSlot> | undefined;
  if (existing !== undefined) return existing;
  const libs: DevToolsLib[] = [];
  const slot: DevToolsSlot = {
    version: 1,
    libs,
    register(lib) {
      if (libs.some((entry) => entry.lib === lib.lib)) {
        throw new Error(`dev tools: the lib "${lib.lib}" is already registered`);
      }
      libs.push(lib);
      return () => {
        const index = libs.indexOf(lib);
        if (index !== -1) libs.splice(index, 1);
      };
    },
  };
  holder[DEV_TOOLS_SLOT] = slot;
  return slot;
}

// ── telescope's tools ──────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const id = { type: 'string', description: 'Entry id' } as const;
const traceId = { type: 'string', description: 'Trace id' } as const;

/** A `{ notice }` answer (an unknown or pruned id) is a tool error. */
async function found(result: Promise<unknown>, notFound?: string): Promise<unknown> {
  const value = await result;
  if (isMcpToolNotice(value)) throw new Error(notFound ?? value.notice);
  return value;
}

/**
 * Telescope's developer tools: the MCP catalogue of `POST <path>/api/mcp`, prefixed `telescope_`,
 * answered by the same {@link TelescopeMcpServer} over the stored (already redacted) entries. An
 * unknown or pruned id is an error ("… not found").
 */
export function telescopeDevTools(server: TelescopeMcpServer): TelescopeDevTool[] {
  return [
    {
      name: 'telescope_list_entries',
      kind: 'read',
      description:
        'List recent telescope entries (requests, queries, exceptions, jobs, logs…), newest first, as compact summaries. Filter by type, search, tag or window. Returns { items, next }: pass next as cursor for the following page (null on the last one).',
      input: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description:
              'Entry type: request, query, exception, client_exception, log, event, mail, job, model, cache, http_client, redis, dump…',
          },
          search: { type: 'string', description: 'Full-text search inside entry content' },
          tag: { type: 'string', description: 'Exact tag, e.g. "status:500" or "slow"' },
          sinceMinutes: {
            type: 'number',
            description: 'Only entries from the last N minutes',
            minimum: 0,
          },
          limit: {
            type: 'integer',
            description: `Max entries (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
            minimum: 1,
            maximum: MAX_LIMIT,
          },
          cursor: { type: 'string', description: 'The `next` of the previous page' },
        },
      },
      run: async (input, call) =>
        server.listEntries({
          ...(input as McpToolArgs),
          limit: Math.min(
            typeof input.limit === 'number' ? input.limit : DEFAULT_LIMIT,
            call?.limits.maxRows ?? MAX_LIMIT,
          ),
        }),
    },
    {
      name: 'telescope_get_entry',
      kind: 'read',
      description:
        'One entry by id with the summaries of its batch (every entry of the same request or job). Returns { entry, batch }.',
      input: { type: 'object', properties: { id }, required: ['id'] },
      run: (input) => found(server.call('get_entry', input as McpToolArgs)),
    },
    {
      name: 'telescope_get_trace',
      kind: 'read',
      description:
        'Every entry recorded under one OpenTelemetry trace id (one request or job), newest first. Returns { entries }.',
      input: { type: 'object', properties: { traceId }, required: ['traceId'] },
      run: (input) => found(server.call('get_trace', input as McpToolArgs)),
    },
    {
      name: 'telescope_get_waterfall',
      kind: 'read',
      description:
        'The span waterfall of one trace: each recorded operation as a nested start/duration span, in order.',
      input: { type: 'object', properties: { traceId }, required: ['traceId'] },
      run: (input) => found(server.call('get_waterfall', input as McpToolArgs)),
    },
    {
      name: 'telescope_get_health',
      kind: 'read',
      description:
        'Pulse health over a trailing window (default 60 minutes): throughput, latency percentiles, slowest requests and queries, hotspots, N+1 suspects, top exception families, cache hit rate.',
      input: {
        type: 'object',
        properties: {
          sinceMinutes: {
            type: 'number',
            description: 'Window in minutes (default 60)',
            minimum: 1,
          },
        },
      },
      run: (input) => server.call('get_health', input as McpToolArgs),
    },
    {
      name: 'telescope_diagnose_exception',
      kind: 'read',
      description:
        'AI diagnosis of an exception entry (probable cause, where to look, a fix), as markdown. Spends AI tokens.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Exception entry id' } },
        required: ['id'],
      },
      available: () => server.canDiagnose(),
      run: (input) =>
        found(
          server.call('diagnose_exception', input as McpToolArgs),
          'Exception entry not found.',
        ),
    },
  ];
}

/** A resolved console gate as a dev-tools gate. Never throws: a throw is `forbidden`. */
export function devToolsGate(decide: ConsoleDecide): DevToolsLib['authorize'] {
  return async (context) => {
    try {
      return await decide(context);
    } catch {
      return { allowed: false, reason: 'forbidden' };
    }
  };
}

/** Whether the console's routes are mounted (`routes !== false`), set by `TelescopeModule`. */
export const TELESCOPE_ROUTES_MOUNTED = Symbol('TELESCOPE_ROUTES_MOUNTED');

const logger = new Logger('TelescopeModule');

/**
 * Registers telescope's tools into the Aviary dev-tools slot, gated by the console's `authorize`,
 * when the console's routes are mounted (or `devTools: true`). Removed again on shutdown.
 */
@Injectable()
export class TelescopeDevToolsRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
    @Inject(TELESCOPE_ROUTES_MOUNTED) private readonly routesMounted: boolean,
    @Inject(TelescopeMcpServer) private readonly server: TelescopeMcpServer,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!(this.options.devTools ?? this.routesMounted)) return;
    const slot = devToolsSlot();
    if (slot.version !== 1 || typeof slot.register !== 'function') return;
    const decide = await resolveConsoleAuthorize(this.options.authorize, this.moduleRef, {
      warnIfMissing: false,
    });
    try {
      this.#unregister = slot.register({
        lib: 'telescope',
        title: 'Telescope',
        authorize: devToolsGate(decide),
        tools: telescopeDevTools(this.server),
      });
    } catch (error) {
      // Another application in this process registered telescope's tools: keep the console up.
      logger.warn(
        `telescope dev tools not registered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}
