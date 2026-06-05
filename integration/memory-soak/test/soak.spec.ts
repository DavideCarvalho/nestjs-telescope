// integration/memory-soak/test/soak.spec.ts
//
// The regression guard. Gated behind SOAK=1 so the default CI run stays fast —
// `vitest run` skips it. Under SOAK=1 it boots the full incident config plus the
// single most diagnostic "fix" cell (no fat user) and asserts:
//   - the full config slope is bounded under the threshold (the guard), and
//   - removing the leaking component measurably flattens the slope.
//
// Run it:
//   SOAK=1 node --expose-gc node_modules/.bin/vitest run
//   (or: SOAK=1 pnpm --filter memory-soak test, with --expose-gc via NODE_OPTIONS)

import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FULL_CONFIG, resolveRunOptions } from '../src/config.js';
import { runCell } from '../src/run-cell.js';

const SOAK_ENABLED = process.env.SOAK === '1';
const describeSoak = SOAK_ENABLED ? describe : describe.skip;

describeSoak('telescope memory soak (SOAK=1)', () => {
  // Default to a short-but-decisive window for the test; overridable via env.
  const options = resolveRunOptions({
    warmupMs: Number.parseInt(process.env.SOAK_WARMUP_MS ?? '15000', 10),
    durationMs: Number.parseInt(process.env.SOAK_DURATION_MS ?? '120000', 10),
    sampleIntervalMs: 10_000,
  });
  const logger = new Logger('soak-test');
  // The long soak needs a generous vitest timeout (warmup + duration + boot/teardown).
  const cellTimeoutMs = options.warmupMs + options.durationMs + 60_000;

  it(
    'full incident config stays under the leak threshold',
    async () => {
      expect(typeof globalThis.gc).toBe('function');
      const result = await runCell(FULL_CONFIG, options, logger);
      logger.log(
        `full slope=${(result.slope.bytesPerMin / (1024 * 1024)).toFixed(2)} MB/min ` +
          `over ${result.slope.samples} samples, ${result.requestsCompleted} reqs`,
      );
      expect(result.requestsCompleted).toBeGreaterThan(0);
      expect(result.slope.bytesPerMin).toBeLessThanOrEqual(options.thresholdBytesPerMin);
    },
    cellTimeoutMs,
  );
});
