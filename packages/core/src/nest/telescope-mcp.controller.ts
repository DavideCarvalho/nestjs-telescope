import { createRequire } from 'node:module';
// packages/core/src/nest/telescope-mcp.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  MethodNotAllowedException,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { PulseService } from '../pulse/pulse.service.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import {
  MCP_TOOLS,
  type McpToolArgs,
  TelescopeMcpServer,
  isMcpToolNotice,
} from './telescope-mcp.server.js';
import { TELESCOPE_OPTIONS, TELESCOPE_STORAGE } from './telescope.options.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

const PROTOCOL_VERSION = '2025-06-18';
/** This package's version, for `serverInfo` (the same `../../package.json` from `src/nest` and `dist/nest`). */
const SERVER_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

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

/**
 * MCP (Model Context Protocol) server — stateless JSON-RPC over streamable HTTP —
 * so coding agents (Claude Code, Cursor, …) can debug straight from the captured
 * data: "why is POST /checkout slow?" → the agent pulls the batch waterfall with
 * every query. Hand-rolled JSON-RPC (no SDK dependency), backed by the same
 * storage / pulse / diagnosis APIs as the dashboard.
 *
 * 404 unless `mcp` is enabled. It carries no guard of its own: the module
 * protects it like every other console route, with `authorize`, or with
 * `mcpAuthorize` in its place (agent clients send a Bearer header:
 * `authorizeByToken({ token })`). Mounted yourself (`routes: false`), put
 * `UseConsoleAuthorize(...)` on your subclass.
 */
@Controller()
export class TelescopeMcpController {
  private readonly server: TelescopeMcpServer;

  constructor(
    @Inject(TELESCOPE_STORAGE) storage: StorageProvider,
    @Inject(TelescopeService) service: TelescopeService,
    @Inject(PulseService) pulse: PulseService,
    @Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions,
  ) {
    this.server = new TelescopeMcpServer(storage, service, pulse);
  }

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
  async rpc(@Body() body: JsonRpcRequest): Promise<unknown> {
    // A feature switch, not access control: disabled means the route doesn't exist.
    if (!this.options.mcp) throw new NotFoundException();
    return this.handle(body);
  }

  private async handle(body: JsonRpcRequest): Promise<unknown> {
    const { id, method, params } = body ?? {};
    try {
      switch (method) {
        case 'initialize':
          return this.respond(id, {
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'nestjs-telescope', version: SERVER_VERSION },
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          // Notifications (no id) get no response body.
          return null;
        case 'ping':
          return this.respond(id, {});
        case 'tools/list':
          return this.respond(id, { tools: MCP_TOOLS });
        case 'tools/call': {
          const name = params?.name;
          // Only the listed catalogue: the server's extra tools belong to the dev-tools endpoint.
          if (!MCP_TOOLS.some((tool) => tool.name === name)) {
            throw new Error(`Unknown tool: ${String(name)}`);
          }
          const text = toText(
            await this.server.call(name, (params?.arguments ?? {}) as McpToolArgs),
          );
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
}

/** What a tool answers, as the text of its MCP content. */
function toText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (isMcpToolNotice(result)) return result.notice;
  return JSON.stringify(result, null, 2);
}
