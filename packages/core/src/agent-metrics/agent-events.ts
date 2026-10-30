// packages/core/src/agent-metrics/agent-events.ts

/**
 * Pure readers for the `aviary:agent:*` events `@dudousxd/nestjs-agent` publishes through
 * `@dudousxd/nestjs-diagnostics` (agent core >= 0.60.0). Telescope cannot import the agent lib, so
 * the payload shapes are read structurally here — every field is optional and type-checked, and an
 * event from an older agent lib simply yields fewer fields, never a throw.
 *
 * Shared by the Prometheus registry, the OTLP metrics exporter and the dashboard's AI screen so the
 * three can never disagree on what "a priced call" or "a run's model time" means.
 */

/** The channel prefix `@dudousxd/nestjs-diagnostics` publishes on (`aviary:<lib>:<event>`). */
export const AGENT_CHANNEL_PREFIX = 'aviary:agent:';

/** The agent events the metrics read. */
export const AGENT_METRIC_EVENTS = [
  'usage.recorded',
  'run.finished',
  'run.failed',
  'run.cancelled',
] as const;
export type AgentMetricEvent = (typeof AGENT_METRIC_EVENTS)[number];

/** The `actorRef` the agent ledger uses for spend the platform pays for, not a user. */
export const PLATFORM_ACTOR_REF = '@platform';

/** Where a call's cost figure came from; `none` means the call had no price at all. */
export type CostSource = 'provider' | 'estimate' | 'none';

/** How a run ended. */
export type RunStatus = 'completed' | 'failed' | 'cancelled';

/** One `usage.recorded` ledger row, reduced to what metrics and the AI screen read. */
export interface UsageObservation {
  kind: 'usage';
  /** Who pays (`@platform` for platform cost). Screen only — NEVER a metric attribute. */
  actorRef: string;
  feature: string;
  model: string;
  /** `'unknown'` when the row carried none. */
  provider: string;
  costSource: CostSource;
  platform: boolean;
  /** Absent when the call had no price (`costSource: 'none'`). */
  costUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  audioSeconds: number;
  characters: number;
  /** `payload.requests ?? 1`. */
  requests: number;
  purpose?: string;
  runId?: string;
  threadId?: string;
}

/** One tool call's share of a step. */
export interface ToolTiming {
  toolName: string;
  ms: number;
}

/** One step: its model call and the tools it ran. */
export interface StepTiming {
  step: number;
  modelMs?: number;
  toolsMs: number;
  tools: ToolTiming[];
}

/** A terminal run event (`run.finished` / `run.failed` / `run.cancelled`). */
export interface RunObservation {
  kind: 'run';
  status: RunStatus;
  /** `agentName`, or `'default'` for the default agent. */
  agent: string;
  runId?: string;
  threadId?: string;
  actorId?: string;
  modelId?: string;
  durationMs?: number;
  ttftMs?: number;
  queueMs?: number;
  modelMs?: number;
  toolsMs?: number;
  steps?: number;
  modelCalls?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Failure slug (`run.failed` only). The error message itself is never read. */
  code?: string;
  stepTimings: StepTiming[];
}

export type AgentObservation = UsageObservation | RunObservation;

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number {
  const n = num(value);
  return n !== undefined && n > 0 ? n : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a `usage.recorded` payload. `null` when it is not one. */
export function readUsage(payload: unknown): UsageObservation | null {
  const p = asRecord(payload);
  if (p === null) return null;
  const actorRef = str(p.actorRef) ?? 'unknown';
  const costUsd = num(p.costUsd);
  const declared = p.costSource === 'provider' || p.costSource === 'estimate' ? p.costSource : null;
  // A cost with no declared source was priced by someone; the ledger's default is the provider.
  const costSource: CostSource = costUsd === undefined ? 'none' : (declared ?? 'provider');
  const requests = num(p.requests);
  const purpose = str(p.purpose);
  const runId = str(p.runId);
  const threadId = str(p.threadId);
  return {
    kind: 'usage',
    actorRef,
    feature: str(p.feature) ?? 'unknown',
    model: str(p.modelId) ?? 'unknown',
    provider: str(p.provider) ?? 'unknown',
    costSource,
    platform: actorRef === PLATFORM_ACTOR_REF,
    ...(costUsd !== undefined ? { costUsd } : {}),
    inputTokens: nonNegative(p.inputTokens),
    outputTokens: nonNegative(p.outputTokens),
    cacheReadTokens: nonNegative(p.cacheReadTokens),
    cacheWriteTokens: nonNegative(p.cacheWriteTokens),
    audioSeconds: nonNegative(p.audioSeconds),
    characters: nonNegative(p.characters),
    requests: requests !== undefined && requests >= 0 ? requests : 1,
    ...(purpose !== undefined ? { purpose } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

function readStepTimings(value: unknown): StepTiming[] {
  if (!Array.isArray(value)) return [];
  const steps: StepTiming[] = [];
  for (const raw of value) {
    const s = asRecord(raw);
    if (s === null) continue;
    const tools: ToolTiming[] = [];
    if (Array.isArray(s.tools)) {
      for (const rawTool of s.tools) {
        const t = asRecord(rawTool);
        const ms = num(t?.ms);
        if (t === null || ms === undefined) continue;
        tools.push({ toolName: str(t.toolName) ?? 'unknown', ms });
      }
    }
    const modelMs = num(s.modelMs);
    steps.push({
      step: num(s.step) ?? steps.length,
      ...(modelMs !== undefined ? { modelMs } : {}),
      toolsMs: num(s.toolsMs) ?? 0,
      tools,
    });
  }
  return steps;
}

const RUN_STATUS: Record<string, RunStatus> = {
  'run.finished': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};

/**
 * Read a terminal run payload. `run.finished` carries the run context (agentName, actorId) at the
 * top level; `run.failed` / `run.cancelled` carry it under `context` — both are read.
 */
export function readRun(event: string, payload: unknown): RunObservation | null {
  const status = RUN_STATUS[event];
  const p = asRecord(payload);
  if (status === undefined || p === null) return null;
  const context = asRecord(p.context) ?? {};
  const pick = (key: string): unknown => p[key] ?? context[key];
  const out: RunObservation = {
    kind: 'run',
    status,
    agent: str(pick('agentName')) ?? 'default',
    stepTimings: readStepTimings(p.stepTimings),
  };
  const strings = ['runId', 'threadId', 'actorId', 'modelId', 'code'] as const;
  for (const key of strings) {
    const value = str(pick(key));
    if (value !== undefined) out[key] = value;
  }
  const numbers = [
    'durationMs',
    'ttftMs',
    'queueMs',
    'modelMs',
    'toolsMs',
    'steps',
    'modelCalls',
    'toolCalls',
    'inputTokens',
    'outputTokens',
    'costUsd',
  ] as const;
  for (const key of numbers) {
    const value = num(p[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Read any agent event the metrics care about; `null` for every other event. */
export function readAgentEvent(event: string, payload: unknown): AgentObservation | null {
  if (event === 'usage.recorded') return readUsage(payload);
  return readRun(event, payload);
}

/**
 * The agent event a stored Telescope entry carries, whichever watcher recorded it:
 * - `@dudousxd/nestjs-agent-telescope` records `type: 'agent'` with `content: { event, ...payload }`;
 * - `@dudousxd/nestjs-diagnostics-telescope` records `type: 'diagnostic'` with
 *   `content: { lib: 'agent', event, payload }`.
 * `null` for any other entry.
 */
export function agentEventOfEntry(entry: {
  type: string;
  content: unknown;
}): { event: string; payload: unknown } | null {
  const content = asRecord(entry.content);
  if (content === null) return null;
  const event = str(content.event);
  if (event === undefined) return null;
  if (entry.type === 'agent') return { event, payload: content };
  if (entry.type === 'diagnostic' && content.lib === 'agent' && content.phase === undefined) {
    return { event, payload: content.payload };
  }
  return null;
}
