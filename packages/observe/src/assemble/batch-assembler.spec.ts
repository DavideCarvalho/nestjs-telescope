// packages/observe/src/assemble/batch-assembler.spec.ts
import type { BatchOrigin, Entry } from '@dudousxd/nestjs-telescope';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssembledBatch } from './assembled-batch.js';
import { BatchAssembler, type BatchAssemblerOptions } from './batch-assembler.js';

const GRACE_MS = 5_000;

let now = 0;
const clock = () => now;

let warnings: string[] = [];
let debugs: string[] = [];

const logger = {
  warn: (message: string) => warnings.push(message),
  debug: (message: string) => debugs.push(message),
};

function makeAssembler(overrides: Partial<BatchAssemblerOptions> = {}): BatchAssembler {
  return new BatchAssembler({
    batchGraceMs: GRACE_MS,
    maxOpenBatches: 1_000,
    clock,
    logger,
    ...overrides,
  });
}

let nextId = 0;

function entry(
  batchId: string,
  type: string,
  sequence: number,
  origin: BatchOrigin = 'http',
  createdAt = new Date(now),
): Entry {
  nextId += 1;
  return {
    id: `e${nextId}`,
    batchId,
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence,
    durationMs: null,
    origin,
    instanceId: 'i1',
    traceId: null,
    spanId: null,
    createdAt,
  };
}

function byBatchId(batches: AssembledBatch[]): Map<string, AssembledBatch> {
  return new Map(batches.map((batch) => [batch.batchId, batch]));
}

const types = (batch: AssembledBatch) => batch.children.map((child) => child.type);
const ids = (batches: AssembledBatch[]) => batches.map((batch) => batch.batchId);

beforeEach(() => {
  now = 0;
  nextId = 0;
  warnings = [];
  debugs = [];
});

describe('BatchAssembler', () => {
  it('joins entries of one batch arriving across three flushes, root last', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'query', 1)]);
    now = 100;
    assembler.add([entry('b1', 'cache', 2), entry('b1', 'log', 3)]);
    now = 200;
    assembler.add([entry('b1', 'request', 4)]);

    expect(assembler.openCount).toBe(1);

    now = 200 + GRACE_MS;
    const drained = assembler.drain();

    expect(drained).toHaveLength(1);
    expect(drained[0]!.batchId).toBe('b1');
    expect(drained[0]!.origin).toBe('http');
    expect(drained[0]!.root?.type).toBe('request');
    expect(types(drained[0]!)).toEqual(['query', 'cache', 'log']);
    expect(assembler.openCount).toBe(0);
  });

  it('holds a batch while its grace window has not elapsed', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'request', 1)]);

    now = GRACE_MS - 1;
    expect(assembler.drain()).toEqual([]);
    expect(assembler.openCount).toBe(1);

    now = GRACE_MS;
    expect(assembler.drain()).toHaveLength(1);
  });

  it('restarts the grace window from the last entry, not the first', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'query', 1)]);
    now = GRACE_MS - 1;
    assembler.add([entry('b1', 'query', 2)]);

    now = GRACE_MS + 1;
    expect(assembler.drain()).toEqual([]);

    now = GRACE_MS - 1 + GRACE_MS;
    const drained = assembler.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.children).toHaveLength(2);
  });

  it('sorts children by sequence, then createdAt', () => {
    const assembler = makeAssembler();

    assembler.add([
      entry('b1', 'log', 5, 'http', new Date(50)),
      entry('b1', 'query', 2, 'http', new Date(20)),
      entry('b1', 'cache', 2, 'http', new Date(10)),
      entry('b1', 'redis', 1, 'http', new Date(30)),
    ]);

    now = GRACE_MS;
    const drained = assembler.drain();

    expect(types(drained[0]!)).toEqual(['redis', 'cache', 'query', 'log']);
  });

  it('treats a job entry as the root for queue and schedule origins only', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'query', 1, 'queue'), entry('b1', 'job', 2, 'queue')]);
    assembler.add([entry('b2', 'job', 1, 'schedule')]);
    assembler.add([entry('b3', 'job', 1, 'cli')]);

    now = GRACE_MS;
    const drained = byBatchId(assembler.drain());

    expect(drained.get('b1')?.root?.type).toBe('job');
    expect(drained.get('b1')?.origin).toBe('queue');
    expect(drained.get('b2')?.root?.type).toBe('job');
    expect(drained.get('b3')?.root).toBeNull();
    expect(drained.get('b3')?.children).toHaveLength(1);
  });

  it('knows a batch origin before its root arrives', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'query', 1, 'queue')]);

    now = GRACE_MS;
    const drained = assembler.drain();

    expect(drained[0]!.origin).toBe('queue');
    expect(drained[0]!.root).toBeNull();
  });

  it('opens a new rootless batch for an entry arriving after its batch drained', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'request', 1), entry('b1', 'query', 2)]);
    now = GRACE_MS;
    expect(assembler.drain()).toHaveLength(1);

    assembler.add([entry('b1', 'query', 3)]);
    expect(assembler.openCount).toBe(1);

    now = GRACE_MS * 2;
    const late = assembler.drain();

    expect(late[0]!.batchId).toBe('b1');
    expect(late[0]!.root).toBeNull();
    expect(late[0]!.children.map((child) => child.sequence)).toEqual([3]);
  });

  it('keeps interleaved batches separate', () => {
    const assembler = makeAssembler();

    assembler.add([entry('b1', 'query', 1), entry('b2', 'query', 1)]);
    assembler.add([entry('b2', 'request', 2), entry('b1', 'cache', 2)]);

    now = GRACE_MS;
    const drained = assembler.drain();

    expect(drained).toHaveLength(2);
    const byId = byBatchId(drained);
    expect(byId.get('b1')?.root).toBeNull();
    expect(byId.get('b1')?.children).toHaveLength(2);
    expect(byId.get('b2')?.root?.type).toBe('request');
    expect(byId.get('b2')?.children).toHaveLength(1);
  });

  it('keeps the first root candidate and demotes the duplicate to a child', () => {
    const assembler = makeAssembler();

    const first = entry('b1', 'request', 1);
    const second = entry('b1', 'request', 2);
    assembler.add([first, second]);

    now = GRACE_MS;
    const drained = assembler.drain();

    expect(drained[0]!.root?.id).toBe(first.id);
    expect(drained[0]!.children.map((child) => child.id)).toEqual([second.id]);
    expect(assembler.duplicateRootCount).toBe(1);
    expect(debugs).toHaveLength(1);
  });

  it('force-emits the oldest batches past maxOpenBatches and warns once per drain', () => {
    const assembler = makeAssembler({ maxOpenBatches: 2 });

    assembler.add([entry('b1', 'query', 1)]);
    now = 1;
    assembler.add([entry('b2', 'query', 1)]);
    now = 2;
    assembler.add([entry('b3', 'query', 1)]);
    now = 3;
    assembler.add([entry('b4', 'query', 1)]);

    expect(assembler.openCount).toBe(2);
    expect(warnings).toEqual([]);

    const shed = assembler.drain();

    expect(ids(shed)).toEqual(['b1', 'b2']);
    expect(shed[0]!.children).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2 batch(es) force-emitted');
    expect(warnings[0]).toContain('maxOpenBatches (2)');

    expect(assembler.drain()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('evicts by last touch, not by first sight', () => {
    const assembler = makeAssembler({ maxOpenBatches: 2 });

    assembler.add([entry('b1', 'query', 1)]);
    now = 1;
    assembler.add([entry('b2', 'query', 1)]);
    now = 2;
    assembler.add([entry('b1', 'query', 2)]);
    now = 3;
    assembler.add([entry('b3', 'query', 1)]);

    expect(ids(assembler.drain())).toEqual(['b2']);
    expect(assembler.openCount).toBe(2);
  });

  it('drains everything on drainAll regardless of the grace window', () => {
    const assembler = makeAssembler({ maxOpenBatches: 1 });

    assembler.add([entry('b1', 'request', 1)]);
    now = 1;
    assembler.add([entry('b2', 'request', 1)]);
    now = 2;
    assembler.add([entry('b3', 'request', 1)]);

    const all = assembler.drainAll();

    expect(ids(all).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(assembler.openCount).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(assembler.drainAll()).toEqual([]);
  });
});
