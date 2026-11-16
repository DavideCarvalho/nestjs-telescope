// packages/core/src/query/ignore-queries.spec.ts
import { describe, expect, it } from 'vitest';
import { TelescopeContext } from '../context/telescope-context.js';
import { Recorder } from '../recorder/recorder.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { compileQueryIgnore } from './ignore-queries.js';
import { detectNPlusOne } from './n-plus-one.js';

const query = (sql: string) => ({ type: 'query', content: { sql, bindings: [] } });

describe('compileQueryIgnore', () => {
  it('is null without rules', () => {
    expect(compileQueryIgnore(undefined)).toBeNull();
    expect(compileQueryIgnore([])).toBeNull();
  });

  it('matches a string as a case-insensitive, whitespace-collapsed substring', () => {
    const ignore = compileQueryIgnore(['select * from durable_workflow_runs where id = ?'])!;
    expect(ignore(query('SELECT *\n  FROM durable_workflow_runs\n  WHERE id = ?'))).toBe(true);
    expect(ignore(query('select * from users where id = ?'))).toBe(false);
  });

  it('tests a RegExp, including a global one more than once', () => {
    const ignore = compileQueryIgnore([/from "?durable_/g])!;
    expect(ignore(query('select 1 from durable_runs'))).toBe(true);
    expect(ignore(query('select 1 from durable_runs'))).toBe(true);
    expect(ignore(query('select 1 from runs'))).toBe(false);
  });

  it('calls a predicate with the sql and content, keeping the query when it throws', () => {
    const ignore = compileQueryIgnore([
      (_sql, content) => content.connection === 'poller',
      () => {
        throw new Error('broken rule');
      },
    ])!;
    expect(ignore({ type: 'query', content: { sql: 'x', connection: 'poller' } })).toBe(true);
    expect(ignore({ type: 'query', content: { sql: 'x', connection: 'main' } })).toBe(false);
  });

  it('never matches another entry type', () => {
    const ignore = compileQueryIgnore(['select'])!;
    expect(ignore({ type: 'request', content: { sql: 'select' } })).toBe(false);
  });
});

describe('Recorder ignoreQueries', () => {
  it('drops matching queries and keeps N+1 detection on the rest', async () => {
    const storage = new InMemoryStorageProvider();
    let counter = 0;
    const recorder = new Recorder({
      storage,
      context: new TelescopeContext(),
      instanceId: 'pod-1',
      taggers: [],
      redact: {},
      sampling: {},
      bufferSize: 100,
      delay: () => Promise.resolve(),
      idFactory: () => `id-${counter++}`,
      ignoreQueries: ['from durable_workflow_runs'],
    });
    for (let i = 0; i < 10; i++) {
      recorder.record({
        ...query('select * from durable_workflow_runs where id = ?'),
        familyHash: 'poll',
      });
    }
    for (let i = 0; i < 6; i++) {
      recorder.record({ ...query('select * from posts where user_id = ?'), familyHash: 'posts' });
    }
    await recorder.flush();

    const stored = (await storage.get({ limit: 100 })).data;
    expect(stored).toHaveLength(6);
    expect(recorder.droppedCount).toBe(0);
    expect(detectNPlusOne(stored, 5).map((insight) => insight.familyHash)).toEqual(['posts']);
  });
});
