// packages/official/src/resilience.watcher.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { ChannelWatcher, eventOf } from './channel-watcher.js';
import { OFFICIAL_CHANNEL_NAMES, OfficialEntryType } from './channels.js';
import { asRecord, num, pick, readError, str } from './read.js';

/** Events where the policy refused or cut short a call. Tagged `failed`. */
const REFUSALS = new Set([
  'timeout',
  'circuit-open',
  'circuit-rejected',
  'bulkhead-rejected',
  'rate-limited',
]);

/**
 * Map a `nestjs:resilience:<type>` event (`@nestjs/resilience`) to a `resilience` entry: the policy
 * and entrypoint, plus whatever the type carries (attempt and delay, timeout budget, breaker state
 * change, retry-after, bulkhead load). Grouped (`familyHash`) by event and policy.
 */
export function resilienceEntry(channel: string, message: unknown): RecordInput | null {
  const p = asRecord(message);
  if (p === null) return null;
  const event = str(p.type) ?? eventOf(channel);
  const policy = str(p.policy) ?? 'unknown';
  const content: Record<string, unknown> = {
    event,
    policy,
    ...pick(p, ['source', 'from', 'to', 'reason'], str),
    ...pick(p, ['attempt', 'delayMs', 'timeoutMs', 'retryAfterMs', 'active', 'queued'], num),
  };
  const error = readError(p.error);
  if (error !== null) content.error = error;
  const tags = [`resilience:${event}`];
  if (REFUSALS.has(event)) tags.push('failed');
  return { type: OfficialEntryType.Resilience, familyHash: `${event}:${policy}`, content, tags };
}

/** Records `@nestjs/resilience`'s retries, timeouts, breaker transitions, refusals and fallbacks. */
export class NestResilienceWatcher extends ChannelWatcher {
  constructor() {
    super(OfficialEntryType.Resilience, OFFICIAL_CHANNEL_NAMES.resilience, resilienceEntry);
  }
}
