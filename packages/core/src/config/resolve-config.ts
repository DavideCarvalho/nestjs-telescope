// packages/core/src/config/resolve-config.ts
import { hostname } from 'node:os';
import { z } from 'zod';
import { resolveProfilingConfig } from '../profiling/profiling-config.js';
import { BUILTIN_TAGGERS } from '../tagging/tagger.js';
import { normalizeTelescopePath } from './normalize-path.js';
import type {
  ResolvedCoreConfig,
  SamplingConfig,
  SamplingRule,
  TelescopeCoreOptions,
} from './options.js';
import { durationToMs } from './parse-duration.js';

const RATE = z.number().min(0).max(1);

const SAMPLING_RULE = z.object({
  rate: RATE,
  keepErrors: z.boolean().optional(),
  keepSlowMs: z.number().nonnegative().optional(),
});

const PER_TYPE_SAMPLING = z.union([RATE, SAMPLING_RULE]);

const optionsSchema = z.object({
  enabled: z.boolean().default(true),
  sampling: z.union([RATE, z.record(PER_TYPE_SAMPLING)]).optional(),
  recorder: z
    .object({
      bufferSize: z.number().int().positive().default(10_000),
      flushIntervalMs: z.number().int().positive().default(1_000),
      flushBatchSize: z.number().int().positive().default(500),
      retryDelayMs: z.number().int().nonnegative().default(1_000),
    })
    .default({}),
  prune: z
    .object({
      after: z.union([z.number().positive(), z.string()]),
      keepLast: z.number().int().nonnegative().optional(),
      intervalMs: z.number().int().positive().default(60_000),
      perType: z.record(z.union([z.number().positive(), z.string()])).optional(),
    })
    .optional(),
  archive: z
    .object({
      types: z.array(z.string()).nonempty(),
      // The sink is a runtime function; zod can only assert it is callable. The
      // precise `(entries: Entry[]) => Promise<void>` shape is enforced by the
      // TelescopeCoreOptions type at the call site, so we copy it through from
      // the original options object below rather than from the parsed value.
      sink: z.function(),
      batchSize: z.number().int().positive().default(500),
      maxBatchesPerCycle: z.number().int().positive().default(10),
    })
    .optional(),
  instanceId: z.string().optional(),
});

type ParsedSampling = z.infer<typeof optionsSchema>['sampling'];

/**
 * Builds a clean {@link SamplingRule}, omitting optional keys that are absent
 * rather than setting them to `undefined` — required under
 * `exactOptionalPropertyTypes`, since zod types optionals as `T | undefined`.
 */
function toSamplingRule(rule: z.infer<typeof SAMPLING_RULE>): SamplingRule {
  const normalized: SamplingRule = { rate: rule.rate };
  if (rule.keepErrors !== undefined) {
    normalized.keepErrors = rule.keepErrors;
  }
  if (rule.keepSlowMs !== undefined) {
    normalized.keepSlowMs = rule.keepSlowMs;
  }
  return normalized;
}

function normalizeSampling(sampling: ParsedSampling): SamplingConfig {
  if (sampling === undefined) return {};
  if (typeof sampling === 'number') return { default: sampling };
  const normalized: SamplingConfig = {};
  for (const [type, rule] of Object.entries(sampling)) {
    normalized[type] = typeof rule === 'number' ? rule : toSamplingRule(rule);
  }
  return normalized;
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
    profiling: resolveProfilingConfig(options.profiling),
    ...(options.traceContext ? { traceContext: options.traceContext } : {}),
    ...(options.traceLink ? { traceLink: options.traceLink } : {}),
  };
  if (parsed.prune) {
    // Resolve per-type overrides through the SAME duration parser as `after`, so
    // a bad per-type duration fails the boot here rather than silently skipping
    // that type at prune time. Absent `perType` yields `{}` → identical to the
    // pre-existing single-cutoff behaviour.
    const perTypeMs: Record<string, number> = {};
    if (parsed.prune.perType) {
      for (const [type, duration] of Object.entries(parsed.prune.perType)) {
        perTypeMs[type] = durationToMs(duration);
      }
    }
    const pruneEntry: ResolvedCoreConfig['prune'] = {
      afterMs: durationToMs(parsed.prune.after),
      intervalMs: parsed.prune.intervalMs,
      perTypeMs,
    };
    if (parsed.prune.keepLast !== undefined) {
      pruneEntry.keepLast = parsed.prune.keepLast;
    }
    resolved.prune = pruneEntry;
  }
  // `archive` carries a runtime `sink` function whose precise signature zod can't
  // express; take the function from the original (typed) options object so the
  // resolved config keeps the exact `(Entry[]) => Promise<void>` type, no cast.
  if (parsed.archive && options.archive) {
    resolved.archive = {
      types: new Set(parsed.archive.types),
      sink: options.archive.sink,
      batchSize: parsed.archive.batchSize,
      maxBatchesPerCycle: parsed.archive.maxBatchesPerCycle,
    };
  }
  if (options.filter !== undefined) {
    resolved.filter = options.filter;
  }
  return resolved;
}
