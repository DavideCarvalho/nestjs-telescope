// packages/core/src/nest/telescope-mcp.controller.spec.ts
import { MethodNotAllowedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/resolve-config.js';
import { EntryType } from '../entry/entry.js';
import { PulseService } from '../pulse/pulse.service.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { TelescopeMcpController } from './telescope-mcp.controller.js';
import type { TelescopeModuleOptions } from './telescope.options.js';
import { TelescopeService } from './telescope.service.js';

function build(options: TelescopeModuleOptions = {}) {
  const storage = new InMemoryStorageProvider();
  const service = new TelescopeService(resolveConfig(options), storage, options);
  const pulse = new PulseService(storage);
  const controller = new TelescopeMcpController(storage, service, pulse, options);
  return { storage, service, controller };
}

const reqWith = (token?: string) => ({
  headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
});

describe('TelescopeMcpController', () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = original;
  });

  it('GET returns 405 (stateless transport)', () => {
    const { controller } = build({ mcp: true });
    expect(() => controller.getStream()).toThrow(MethodNotAllowedException);
  });

  it('DELETE is a 200 no-op', () => {
    const { controller } = build({ mcp: true });
    expect(controller.deleteSession()).toEqual({ ok: true });
  });

  it('lists tools via tools/list', async () => {
    const { controller } = build({ mcp: true });
    const res = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as { result: { tools: { name: string }[] } };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toEqual([
      'list_entries',
      'get_entry',
      'get_batch',
      'get_stats',
      'diagnose_exception',
    ]);
  });

  it('list_entries returns slimmed request entries', async () => {
    const { controller, service, storage } = build({ mcp: true });
    service.beginBatch('http');
    service.record({
      type: EntryType.Request,
      content: { method: 'GET', uri: '/x', statusCode: 200 },
    });
    await service.flush();
    const stored = (await storage.get({})).data[0];

    const res = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_entries', arguments: {} },
    })) as { result: { content: { text: string }[] } };
    const payload = JSON.parse(res.result.content[0]?.text ?? '{}');
    expect(payload.entries[0].id).toBe(stored?.id);
    expect(payload.entries[0].summary).toBe('GET /x → 200');
  });

  it('rejects a request with a wrong/absent token when one is configured', async () => {
    const { controller } = build({ mcp: { token: 'secret' } });
    const denied = (await controller.rpc(reqWith('nope'), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })) as { error: { code: number } };
    expect(denied.error.code).toBe(-32001);

    const ok = (await controller.rpc(reqWith('secret'), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    })) as { result: unknown };
    expect(ok.result).toBeDefined();
  });

  it('without a token, allows in dev but denies in production', async () => {
    const { controller } = build({ mcp: true });
    process.env.NODE_ENV = 'development';
    const dev = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 5,
      method: 'ping',
    })) as { result?: unknown; error?: unknown };
    expect(dev.result).toBeDefined();

    process.env.NODE_ENV = 'production';
    const prod = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 6,
      method: 'ping',
    })) as { error: { code: number } };
    expect(prod.error.code).toBe(-32001);
  });

  it('returns a -32601 for an unknown method', async () => {
    const { controller } = build({ mcp: true });
    const res = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 7,
      method: 'bogus',
    })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  it('diagnose_exception reports when AI is off', async () => {
    const { controller, service, storage } = build({ mcp: true });
    service.beginBatch('http');
    service.record({ type: EntryType.Exception, content: { name: 'Err', message: 'boom' } });
    await service.flush();
    const id = (await storage.get({})).data[0]?.id;
    const res = (await controller.rpc(reqWith(), {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'diagnose_exception', arguments: { id } },
    })) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]?.text).toMatch(/not configured/i);
  });
});
