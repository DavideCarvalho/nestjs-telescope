// packages/official/src/workflows.watcher.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { ChannelWatcher, eventOf } from './channel-watcher.js';
import { OFFICIAL_CHANNEL_NAMES, OfficialEntryType } from './channels.js';
import { asRecord, num, pick, readError, str } from './read.js';

const FAILURES = new Set([
  'workflow-failed',
  'workflow-compensation-failed',
  'step-failed',
  'signal-timed-out',
]);

const STRINGS = [
  'id',
  'workflow',
  'step',
  'child',
  'childWorkflow',
  'wait',
  'signal',
  'reason',
] as const;
const NUMBERS = [
  'version',
  'at',
  'run',
  'wakeAt',
  'attempt',
  'durationMs',
  'retryAt',
  'childVersion',
  'signalId',
  'entries',
  'bytes',
] as const;

/**
 * Map a `nestjs:workflows:<type>` event (`@nestjs/workflows`) to a `workflow` entry. Grouped by
 * workflow name, so "All workflow like this" lists one definition's lifecycle. `output` and the
 * custom `status` are the app's own data: they go through Telescope's redaction and size bounds
 * like any recorded payload. `from` is a status on `workflow-retried` and a timestamp on
 * `schedule-skipped`; both are kept as given.
 */
export function workflowEntry(channel: string, message: unknown): RecordInput | null {
  const p = asRecord(message);
  if (p === null) return null;
  const event = str(p.type) ?? eventOf(channel);
  const workflow = str(p.workflow) ?? 'unknown';
  const content: Record<string, unknown> = {
    event,
    ...pick(p, STRINGS, str),
    ...pick(p, NUMBERS, num),
  };
  for (const key of ['from', 'to', 'status', 'output', 'waits'] as const) {
    if (p[key] !== undefined) content[key] = p[key];
  }
  const error = readError(p.error);
  if (error !== null) content.error = error;
  const tags = [`workflow:${event}`];
  if (FAILURES.has(event)) tags.push('failed');
  const input: RecordInput = {
    type: OfficialEntryType.Workflow,
    familyHash: workflow,
    content,
    tags,
  };
  const durationMs = num(p.durationMs);
  if (durationMs !== undefined) input.durationMs = durationMs;
  return input;
}

/** Records `@nestjs/workflows`' instance and step lifecycle, signals, schedules and journal warnings. */
export class NestWorkflowsWatcher extends ChannelWatcher {
  constructor() {
    super(OfficialEntryType.Workflow, OFFICIAL_CHANNEL_NAMES.workflows, workflowEntry);
  }
}
