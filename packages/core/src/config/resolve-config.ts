// packages/core/src/config/resolve-config.ts
import { hostname } from 'node:os';
import { z } from 'zod';
import { BUILTIN_TAGGERS } from '../tagging/tagger.js';
import { normalizeTelescopePath } from './normalize-path.js';
import type { ResolvedCoreConfig, TelescopeCoreOptions } from './options.js';
import { durationToMs } from './parse-duration.js';

const RATE = z.number().min(0).max(1);

const optionsSchema = z.object({
  enabled: z.boolean().default(true),
  sampling: z.union([RATE, z.record(RATE)]).optional(),
  recorder: z
    .object({
      bufferSize: z.number().int().positive().default(10_000),
      flushIntervalMs: z.number().int().positive().default(1_000),
      flushBatchSize: z.number().int().positive().default(500),
    })
    .default({}),
  prune: z
    .object({
      after: z.union([z.number().positive(), z.string()]),
      keepLast: z.number().int().nonnegative().optional(),
      intervalMs: z.number().int().positive().default(60_000),
    })
    .optional(),
  instanceId: z.string().optional(),
});

function normalizeSampling(
  sampling: number | Record<string, number> | undefined,
): Record<string, number> {
  if (sampling === undefined) return {};
  return typeof sampling === 'number' ? { default: sampling } : sampling;
}

export function resolveConfig(options: TelescopeCoreOptions): ResolvedCoreConfig {
  const parsed = optionsSchema.parse(options);
  const resolved: ResolvedCoreConfig = {
    enabled: parsed.enabled,
    path: normalizeTelescopePath(options.path),
    redact: options.redact ?? {},
    sampling: normalizeSampling(parsed.sampling),
    recorder: parsed.recorder,
    taggers: [...BUILTIN_TAGGERS, ...(options.taggers ?? [])],
    instanceId: parsed.instanceId ?? hostname(),
    ...(options.traceContext ? { traceContext: options.traceContext } : {}),
    ...(options.traceLink ? { traceLink: options.traceLink } : {}),
  };
  if (parsed.prune) {
    const pruneEntry: ResolvedCoreConfig['prune'] = {
      afterMs: durationToMs(parsed.prune.after),
      intervalMs: parsed.prune.intervalMs,
    };
    if (parsed.prune.keepLast !== undefined) {
      pruneEntry.keepLast = parsed.prune.keepLast;
    }
    resolved.prune = pruneEntry;
  }
  if (options.filter !== undefined) {
    resolved.filter = options.filter;
  }
  return resolved;
}
