// packages/core/src/context/telescope-context.spec.ts
import { describe, expect, it } from 'vitest';
import { createBatch } from './batch.js';
import { TelescopeContext } from './telescope-context.js';

describe('TelescopeContext', () => {
  it('exposes the active batch only inside run()', async () => {
    const ctx = new TelescopeContext();
    expect(ctx.current()).toBeUndefined();

    const batch = createBatch('http', () => 'batch-1');
    await ctx.run(batch, async () => {
      expect(ctx.current()?.id).toBe('batch-1');
    });

    expect(ctx.current()).toBeUndefined();
  });

  it('hands out monotonic sequence numbers within a batch', async () => {
    const ctx = new TelescopeContext();
    const batch = createBatch('queue', () => 'b');
    await ctx.run(batch, async () => {
      expect(ctx.nextSequence()).toBe(0);
      expect(ctx.nextSequence()).toBe(1);
      expect(ctx.nextSequence()).toBe(2);
    });
  });

  it('isolates sequences across concurrent batches', async () => {
    const ctx = new TelescopeContext();
    const a = ctx.run(
      createBatch('http', () => 'a'),
      async () => {
        await Promise.resolve();
        return ctx.nextSequence();
      },
    );
    const b = ctx.run(
      createBatch('http', () => 'b'),
      async () => ctx.nextSequence(),
    );
    expect(await Promise.all([a, b])).toEqual([0, 0]);
  });
});
