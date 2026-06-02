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

  it('enterWith establishes a batch for the rest of the async execution', async () => {
    const { TelescopeContext } = await import('./telescope-context.js');
    const { createBatch } = await import('./batch.js');
    const ctx = new TelescopeContext();

    async function handler() {
      // No callback scope here — the batch must already be active.
      await Promise.resolve();
      return ctx.current()?.id;
    }

    const seen = await ctx.run(
      createBatch('manual', () => 'outer'),
      async () => {
        ctx.enterWith(createBatch('http', () => 'req-1'));
        return handler();
      },
    );
    expect(seen).toBe('req-1');
  });
});
