// packages/core/src/ai/diagnose-context-builder.spec.ts
import { describe, expect, it } from 'vitest';
import { type Entry, EntryType } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { buildDiagnoseContext } from './diagnose-context-builder.js';

function makeEntry(type: string, overrides: Partial<Entry>): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b1',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

describe('buildDiagnoseContext', () => {
  it('builds a server-exception context from the exception + sibling request', async () => {
    const storage = new InMemoryStorageProvider();
    const exception = makeEntry(EntryType.Exception, {
      id: 'ex',
      familyHash: 'fam-A',
      content: { class: 'TypeError', message: 'boom', stack: 'TypeError: boom\n  at a' },
    });
    const request = makeEntry(EntryType.Request, {
      id: 'req',
      durationMs: 87,
      content: { method: 'POST', uri: '/api/orders', statusCode: 500 },
    });
    await storage.store([exception, request]);

    const context = await buildDiagnoseContext(storage, exception, 4);

    expect(context.exceptionClass).toBe('TypeError');
    expect(context.message).toBe('boom');
    expect(context.client).toBe(false);
    expect(context.request).toEqual({
      route: '/api/orders',
      method: 'POST',
      statusCode: 500,
      durationMs: 87,
    });
    expect(context.occurrenceCount).toBe(4);
  });

  it('collects in-batch query SQL only (no bindings), newest-last', async () => {
    const storage = new InMemoryStorageProvider();
    const exception = makeEntry(EntryType.Exception, { id: 'ex', sequence: 3 });
    const q1 = makeEntry(EntryType.Query, {
      id: 'q1',
      sequence: 1,
      content: { sql: 'select * from a', bindings: ['secret'] },
    });
    const q2 = makeEntry(EntryType.Query, {
      id: 'q2',
      sequence: 2,
      content: { sql: 'select * from b where id = ?', bindings: [42] },
    });
    await storage.store([q1, q2, exception]);

    const context = await buildDiagnoseContext(storage, exception, 1);
    expect(context.recentQueries).toEqual(['select * from a', 'select * from b where id = ?']);
    // Bindings (e.g. 'secret', 42) never appear in the context.
    expect(JSON.stringify(context.recentQueries)).not.toContain('secret');
    expect(JSON.stringify(context.recentQueries)).not.toContain('42');
  });

  it('builds a client-exception context with url/userAgent and no request', async () => {
    const storage = new InMemoryStorageProvider();
    const clientError = makeEntry(EntryType.ClientException, {
      id: 'c1',
      familyHash: 'fam-C',
      content: {
        name: 'RangeError',
        message: 'frontend boom',
        stack: 'RangeError\n  at f',
        url: 'https://x.test/checkout',
        userAgent: 'UA/1.0',
      },
    });
    await storage.store([clientError]);

    const context = await buildDiagnoseContext(storage, clientError, 1);
    expect(context.client).toBe(true);
    expect(context.exceptionClass).toBe('RangeError');
    expect(context.request).toBeNull();
    expect(context.url).toBe('https://x.test/checkout');
    expect(context.userAgent).toBe('UA/1.0');
  });
});
