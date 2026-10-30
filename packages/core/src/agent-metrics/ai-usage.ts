// packages/core/src/agent-metrics/ai-usage.ts
import type { Entry } from '../entry/entry.js';
import {
  type RunObservation,
  type RunStatus,
  type StepTiming,
  type UsageObservation,
  agentEventOfEntry,
  readAgentEvent,
} from './agent-events.js';

/** One row of a spend breakdown (by feature, model or actor). */
export interface AiSpendRow {
  key: string;
  costUsd: number;
  calls: number;
  /** Calls in this group that had no cost. */
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** One time bucket of spend. */
export interface AiSpendBucket {
  /** Bucket start, ISO. */
  start: string;
  costUsd: number;
  platformUsd: number;
  estimatedUsd: number;
  calls: number;
}

/** The spend half of the AI screen. */
export interface AiSpend {
  totalUsd: number;
  /** Paid by the platform (`actorRef === '@platform'`). */
  platformUsd: number;
  /** Priced by an estimate rather than the provider's own figure. */
  estimatedUsd: number;
  calls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  audioSeconds: number;
  byFeature: AiSpendRow[];
  byModel: AiSpendRow[];
  /** Top N payers. `@platform` is the platform itself. */
  byActor: AiSpendRow[];
  buckets: AiSpendBucket[];
}

/** One agent run, as the runs table shows it. */
export interface AiRunRow {
  /** The Telescope entry the run's terminal event was recorded as. */
  entryId: string;
  /** The entry's trace — the link to the existing trace/waterfall view; `null` when none. */
  traceId: string | null;
  at: string;
  status: RunStatus;
  agent: string;
  runId: string | null;
  threadId: string | null;
  modelId: string | null;
  durationMs: number | null;
  ttftMs: number | null;
  queueMs: number | null;
  modelMs: number | null;
  toolsMs: number | null;
  steps: number | null;
  modelCalls: number | null;
  toolCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  /** Failure slug on a failed run. */
  code: string | null;
  stepTimings: StepTiming[];
}

/** Calls with no cost, grouped. */
export interface AiUnpricedRow {
  feature: string;
  model: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  audioSeconds: number;
  characters: number;
  lastAt: string;
}

/**
 * What the window held, so the screen can tell "nothing happened" from "this app's agent lib does
 * not publish these events yet".
 */
export interface AiCoverage {
  usageEvents: number;
  runEvents: number;
  /** Every agent event seen, of any kind (`run.started`, `tool-call`, …). */
  agentEvents: number;
  /** Agent events exist but none is `usage.recorded`: the agent lib predates the ledger event. */
  legacyAgentLib: boolean;
  /** Runs whose terminal event carried no timing breakdown (queue/model/tools). */
  runsWithoutTimings: number;
}

export interface AiUsageSummary {
  windowStart: string;
  windowEnd: string;
  spend: AiSpend;
  /** Most recent first. */
  runs: AiRunRow[];
  slowest: AiRunRow[];
  mostExpensive: AiRunRow[];
  unpriced: AiUnpricedRow[];
  coverage: AiCoverage;
}

export interface SummarizeAiUsageOptions {
  windowStart: Date;
  windowEnd: Date;
  /** Spend time buckets. Default 24. */
  buckets?: number;
  /** Rows per breakdown and per runs table. Default 10 for breakdowns, 50 for runs. */
  top?: number;
  runsLimit?: number;
}

function emptyRow(key: string): AiSpendRow {
  return { key, costUsd: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0 };
}

function addTo(map: Map<string, AiSpendRow>, key: string, u: UsageObservation): void {
  let row = map.get(key);
  if (row === undefined) {
    row = emptyRow(key);
    map.set(key, row);
  }
  row.costUsd += u.costUsd ?? 0;
  row.calls += u.requests;
  if (u.costUsd === undefined) row.unpricedCalls += u.requests;
  row.inputTokens += u.inputTokens;
  row.outputTokens += u.outputTokens;
}

function ranked(map: Map<string, AiSpendRow>, top: number): AiSpendRow[] {
  return [...map.values()]
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.key.localeCompare(b.key))
    .slice(0, top)
    .map((r) => ({ ...r, costUsd: round(r.costUsd) }));
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function toRunRow(entry: Entry, r: RunObservation): AiRunRow {
  return {
    entryId: entry.id,
    traceId: entry.traceId,
    at: new Date(entry.createdAt).toISOString(),
    status: r.status,
    agent: r.agent,
    runId: r.runId ?? null,
    threadId: r.threadId ?? null,
    modelId: r.modelId ?? null,
    durationMs: r.durationMs ?? null,
    ttftMs: r.ttftMs ?? null,
    queueMs: r.queueMs ?? null,
    modelMs: r.modelMs ?? null,
    toolsMs: r.toolsMs ?? null,
    steps: r.steps ?? (r.stepTimings.length > 0 ? r.stepTimings.length : null),
    modelCalls: r.modelCalls ?? null,
    toolCalls: r.toolCalls ?? null,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    costUsd: r.costUsd ?? null,
    code: r.code ?? null,
    stepTimings: r.stepTimings,
  };
}

/**
 * Summarize the agent entries of a window into the AI screen: spend (total, platform and estimated
 * shares, by feature / model / actor, over time), runs (recent, slowest, most expensive, each with
 * its step breakdown) and the unpriced calls. Reads both shapes an agent event is stored in (see
 * {@link agentEventOfEntry}), preferring the agent watcher's when both are present. Entries outside
 * the window are ignored. Pure.
 */
export function summarizeAiUsage(
  entries: readonly Entry[],
  options: SummarizeAiUsageOptions,
): AiUsageSummary {
  const start = options.windowStart.getTime();
  const end = options.windowEnd.getTime();
  const bucketCount = Math.max(1, Math.min(500, Math.floor(options.buckets ?? 24)));
  const top = Math.max(1, Math.floor(options.top ?? 10));
  const runsLimit = Math.max(1, Math.floor(options.runsLimit ?? 50));
  const bucketMs = Math.max(1, (end - start) / bucketCount);

  const buckets: AiSpendBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    start: new Date(start + i * bucketMs).toISOString(),
    costUsd: 0,
    platformUsd: 0,
    estimatedUsd: 0,
    calls: 0,
  }));
  const spend: AiSpend = {
    totalUsd: 0,
    platformUsd: 0,
    estimatedUsd: 0,
    calls: 0,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    audioSeconds: 0,
    byFeature: [],
    byModel: [],
    byActor: [],
    buckets,
  };
  const byFeature = new Map<string, AiSpendRow>();
  const byModel = new Map<string, AiSpendRow>();
  const byActor = new Map<string, AiSpendRow>();
  const unpriced = new Map<string, AiUnpricedRow>();
  const runs: AiRunRow[] = [];
  const coverage: AiCoverage = {
    usageEvents: 0,
    runEvents: 0,
    agentEvents: 0,
    legacyAgentLib: false,
    runsWithoutTimings: 0,
  };

  // The same agent event can be stored twice when both watchers record it (the generic bridge with
  // `recordClaimed: true`). The agent's own watcher wins: once the window holds any `agent` entry,
  // `diagnostic`-shaped agent entries are ignored, so the screen counts each event once, as the
  // channel-fed metrics do.
  const hasTyped = entries.some((e) => e.type === 'agent' && agentEventOfEntry(e) !== null);

  for (const entry of entries) {
    const at = new Date(entry.createdAt).getTime();
    if (at < start || at > end) continue;
    if (hasTyped && entry.type !== 'agent') continue;
    const event = agentEventOfEntry(entry);
    if (event === null) continue;
    coverage.agentEvents += 1;
    const observation = readAgentEvent(event.event, event.payload);
    if (observation === null) continue;

    if (observation.kind === 'run') {
      coverage.runEvents += 1;
      if (
        observation.queueMs === undefined &&
        observation.modelMs === undefined &&
        observation.toolsMs === undefined
      ) {
        coverage.runsWithoutTimings += 1;
      }
      runs.push(toRunRow(entry, observation));
      continue;
    }

    const u = observation;
    coverage.usageEvents += 1;
    const cost = u.costUsd ?? 0;
    spend.totalUsd += cost;
    if (u.platform) spend.platformUsd += cost;
    if (u.costSource === 'estimate') spend.estimatedUsd += cost;
    spend.calls += u.requests;
    spend.inputTokens += u.inputTokens;
    spend.outputTokens += u.outputTokens;
    spend.cacheReadTokens += u.cacheReadTokens;
    spend.cacheWriteTokens += u.cacheWriteTokens;
    spend.audioSeconds += u.audioSeconds;
    addTo(byFeature, u.feature, u);
    addTo(byModel, u.model, u);
    addTo(byActor, u.actorRef, u);

    const bucket = buckets[Math.min(bucketCount - 1, Math.floor((at - start) / bucketMs))];
    if (bucket !== undefined) {
      bucket.costUsd += cost;
      if (u.platform) bucket.platformUsd += cost;
      if (u.costSource === 'estimate') bucket.estimatedUsd += cost;
      bucket.calls += u.requests;
    }

    if (u.costUsd === undefined) {
      spend.unpricedCalls += u.requests;
      const key = `${u.feature}\u0000${u.model}\u0000${u.provider}`;
      let row = unpriced.get(key);
      if (row === undefined) {
        row = {
          feature: u.feature,
          model: u.model,
          provider: u.provider,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          characters: 0,
          lastAt: new Date(at).toISOString(),
        };
        unpriced.set(key, row);
      }
      row.calls += u.requests;
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      row.audioSeconds += u.audioSeconds;
      row.characters += u.characters;
      if (new Date(at).toISOString() > row.lastAt) row.lastAt = new Date(at).toISOString();
    }
  }

  coverage.legacyAgentLib = coverage.agentEvents > 0 && coverage.usageEvents === 0;
  spend.totalUsd = round(spend.totalUsd);
  spend.platformUsd = round(spend.platformUsd);
  spend.estimatedUsd = round(spend.estimatedUsd);
  spend.byFeature = ranked(byFeature, top);
  spend.byModel = ranked(byModel, top);
  spend.byActor = ranked(byActor, top);
  for (const b of buckets) {
    b.costUsd = round(b.costUsd);
    b.platformUsd = round(b.platformUsd);
    b.estimatedUsd = round(b.estimatedUsd);
  }

  runs.sort((a, b) => b.at.localeCompare(a.at));
  const slowest = runs
    .filter((r) => r.durationMs !== null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5);
  const mostExpensive = runs
    .filter((r) => r.costUsd !== null && r.costUsd > 0)
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, 5);

  return {
    windowStart: options.windowStart.toISOString(),
    windowEnd: options.windowEnd.toISOString(),
    spend,
    runs: runs.slice(0, runsLimit),
    slowest,
    mostExpensive,
    unpriced: [...unpriced.values()].sort((a, b) => b.calls - a.calls),
    coverage,
  };
}
