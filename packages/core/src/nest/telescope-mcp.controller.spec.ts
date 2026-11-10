// packages/core/src/nest/telescope-mcp.controller.spec.ts
import { createRequire } from 'node:module';
import { MethodNotAllowedException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
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

describe('TelescopeMcpController', () => {
  it('GET returns 405 (stateless transport)', () => {
    const { controller } = build({ mcp: true });
    expect(() => controller.getStream()).toThrow(MethodNotAllowedException);
  });

  it('initialize reports the package version in serverInfo', async () => {
    const { controller } = build({ mcp: true });
    const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
    const res = (await controller.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(res.result.serverInfo).toEqual({ name: 'nestjs-telescope', version: pkg.version });
    expect(pkg.version).not.toBe('0.0.0');
  });

  it('DELETE is a 200 no-op', () => {
    const { controller } = build({ mcp: true });
    expect(controller.deleteSession()).toEqual({ ok: true });
  });

  it('lists tools via tools/list', async () => {
    const { controller } = build({ mcp: true });
    const res = (await controller.rpc({
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

    const res = (await controller.rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_entries', arguments: {} },
    })) as { result: { content: { text: string }[] } };
    const payload = JSON.parse(res.result.content[0]?.text ?? '{}');
    expect(payload.entries[0].id).toBe(stored?.id);
    expect(payload.entries[0].summary).toBe('GET /x → 200');
  });

  it('404s while `mcp` is not enabled', async () => {
    const { controller } = build({});
    await expect(controller.rpc({ jsonrpc: '2.0', id: 5, method: 'ping' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns a -32601 for an unknown method', async () => {
    const { controller } = build({ mcp: true });
    const res = (await controller.rpc({
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
    const res = (await controller.rpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'diagnose_exception', arguments: { id } },
    })) as { result: { content: { text: string }[] } };
    expect(res.result.content[0]?.text).toMatch(/not configured/i);
  });
});
