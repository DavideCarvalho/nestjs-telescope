// packages/core/src/alerts/telescope-alerter.ts
import { Logger } from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import type { ClientExceptionContent, ExceptionContent, RequestContent } from '../entry/content.js';
import { type Entry, EntryType } from '../entry/entry.js';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { AlertChannel } from './alert-channel.js';
import type {
  AlertPayload,
  AlertRule,
  ExceptionAlertContext,
  ResolvedAlerts,
} from './alert-rule.js';
import { NewExceptionTracker } from './new-exception-tracker.js';

/**
 * Cap on entries scanned per windowed rule read. Alerting is a coarse "did we
 * cross N" check, not analytics — a small cap keeps each tick cheap even on a
 * busy store. Counts at/above the cap still cross any sane threshold, so the cap
 * never hides a firing condition (it only under-counts far above threshold).
 */
const ALERT_SCAN_CAP = 10_000;

/** Stack frames carried in a `new-exception` alert (the Slack channel re-clips). */
const ALERT_STACK_FRAME_LIMIT = 12;

export interface TelescopeAlerterDeps {
  alerts: ResolvedAlerts;
  storage: StorageProvider;
  instanceId: string;
  /** Cumulative Recorder drop count reader (delta-based `dropped-entries` rule). */
  droppedCount: () => number;
  /** Wall-clock seam (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Cap on tracked error families for the `new-exception` rule (test seam). */
  maxFamilies?: number;
  logger?: Logger;
  /**
   * Optional AI-diagnosis lookup for `new-exception` alerts. When set (auto-mode
   * AI configured), the alerter briefly awaits it for the firing family and, if a
   * diagnosis is ready within the grace cap, attaches it to the payload as
   * `diagnosis`. Returning `null` (or being unset) simply means no AI note — the
   * alert fires either way. Never blocks the alert beyond the hook's own cap.
   */
  diagnosisFor?: (familyHash: string) => Promise<string | null>;
}

/**
 * Pluggable-channel alerting (v2). Two evaluation paths:
 *  1. Interval rules (`exception-rate` / `slow-request-rate` / `dropped-entries`)
 *     run on an unref'd timer over windowed counts.
 *  2. The `new-exception` rule runs per-flush via {@link evaluateFlush} over the
 *     just-stored exception entries, so a brand-new error family pages within a
 *     flush interval rather than waiting a full evaluation interval.
 *
 * Every fired alert fans out to ALL configured channels concurrently; one channel
 * failing never blocks the others. NEVER throws into the host: a channel failure
 * is warn-logged (rate-limited per channel) and otherwise swallowed.
 */
export class TelescopeAlerter {
  private readonly logger: Logger;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-rule last-fired wall time (index-keyed; rules are a fixed array). */
  private readonly lastFiredAt = new Map<number, number>();
  /** Per-family last-fired wall time for the `new-exception` cooldown. */
  private readonly lastFiredFamily = new Map<string, number>();
  /** Channels we've already warned about (rate-limit failure logs by name). */
  private readonly warnedChannels = new Set<string>();
  /** Previous cumulative droppedCount, for the `dropped-entries` delta. */
  private lastDroppedCount: number;
  /** Bounded per-replica seen-family map backing the `new-exception` rule. */
  private readonly newExceptionTracker: NewExceptionTracker;
  /** Pre-computed `new-exception` rule (if any) so the flush path is cheap. */
  private readonly newExceptionRule: { type: 'new-exception'; window: string } | null;

  constructor(private readonly deps: TelescopeAlerterDeps) {
    this.logger = deps.logger ?? new Logger(TelescopeAlerter.name);
    this.now = deps.now ?? Date.now;
    this.lastDroppedCount = deps.droppedCount();
    this.newExceptionTracker = new NewExceptionTracker(deps.maxFamilies);
    this.newExceptionRule =
      deps.alerts.rules.find(
        (rule): rule is { type: 'new-exception'; window: string } => rule.type === 'new-exception',
      ) ?? null;
  }

  /** Start the unref'd evaluation interval. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.evaluate().catch((error: unknown) => {
        this.logger.warn(`Telescope alert evaluation failed: ${(error as Error).message}`);
      });
    }, this.deps.alerts.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the interval (shutdown). Idempotent. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluate every INTERVAL rule once (the `new-exception` rule is handled by
   * {@link evaluateFlush}, not here). Each firing rule fans out independently.
   * Exposed for the timer and for deterministic tests.
   */
  async evaluate(): Promise<void> {
    for (let index = 0; index < this.deps.alerts.rules.length; index++) {
      const rule = this.deps.alerts.rules[index];
      if (rule === undefined || rule.type === 'new-exception') continue;
      const outcome = await this.measure(rule);
      if (outcome === null) continue;
      if (this.inCooldown(index)) continue;
      this.lastFiredAt.set(index, this.now());
      await this.dispatch(this.buildRatePayload(rule, outcome.value, outcome.threshold));
    }
  }

  /**
   * Per-flush evaluation for the `new-exception` rule. Called with the entries a
   * flush just stored. MUST be cheap: it filters to exception-type entries and
   * does a single bounded-map lookup per family; the expensive batch-context
   * fetch happens ONLY for a family that actually fires (and is past cooldown).
   * No-op (zero cost beyond the early return) when the rule isn't configured.
   * Never throws into the host — failures are swallowed/logged.
   */
  async evaluateFlush(storedEntries: Entry[]): Promise<void> {
    const rule = this.newExceptionRule;
    if (rule === null) return;
    const windowMs = durationToMs(rule.window);
    const nowMs = this.now();
    try {
      for (const entry of storedEntries) {
        // Server exceptions AND browser-reported client_exceptions both feed the
        // new-exception rule — a brand-new front-end error family should page
        // just like a server one.
        if (entry.type !== EntryType.Exception && entry.type !== EntryType.ClientException) {
          continue;
        }
        if (entry.familyHash === null) continue;
        const isNew = this.newExceptionTracker.observe(entry.familyHash, nowMs, windowMs);
        if (!isNew) continue;
        if (this.familyInCooldown(entry.familyHash, nowMs)) continue;
        this.lastFiredFamily.set(entry.familyHash, nowMs);
        // Only NOW do we pay for the batch-context fetch + dispatch.
        const payload = await this.buildNewExceptionPayload(rule, entry, windowMs, nowMs);
        await this.dispatch(payload);
      }
    } catch (error: unknown) {
      // A bug in evaluation must never break the host's flush path.
      this.logger.warn(`Telescope new-exception evaluation failed: ${(error as Error).message}`);
    }
  }

  /** Returns `{ value, threshold }` when an interval rule is firing, else `null`. */
  private async measure(
    rule: Exclude<AlertRule, { type: 'new-exception' }>,
  ): Promise<{ value: number; threshold: number } | null> {
    if (rule.type === 'exception-rate') {
      const value = await this.countInWindow(rule.window, EntryType.Exception);
      return value >= rule.threshold ? { value, threshold: rule.threshold } : null;
    }
    if (rule.type === 'slow-request-rate') {
      const value = await this.countSlowRequests(rule.window, rule.thresholdMs);
      return value >= rule.count ? { value, threshold: rule.count } : null;
    }
    // dropped-entries: delta since the previous evaluation.
    const current = this.deps.droppedCount();
    const delta = current - this.lastDroppedCount;
    this.lastDroppedCount = current;
    return delta >= rule.threshold ? { value: delta, threshold: rule.threshold } : null;
  }

  /** Count entries of `type` recorded in the trailing `window`. */
  private async countInWindow(window: string, type: string): Promise<number> {
    const result = await this.readWindow(window, type);
    return result.length;
  }

  /** Count request entries in the window whose `durationMs >= thresholdMs`. */
  private async countSlowRequests(window: string, thresholdMs: number): Promise<number> {
    const entries = await this.readWindow(window, EntryType.Request);
    let slow = 0;
    for (const entry of entries) {
      if (typeof entry.durationMs === 'number' && entry.durationMs >= thresholdMs) {
        slow += 1;
      }
    }
    return slow;
  }

  /**
   * Small windowed read reusing the analytics scan: `omitContent` (alerting only
   * needs counts + `durationMs`, never payloads) and a tight `scanCap`.
   */
  private async readWindow(window: string, type: string) {
    const after = new Date(this.now() - durationToMs(window));
    const result = await collectEntriesInWindow(
      this.deps.storage,
      { type, after, omitContent: true },
      { scanCap: ALERT_SCAN_CAP },
    );
    return result.entries;
  }

  private inCooldown(index: number): boolean {
    const last = this.lastFiredAt.get(index);
    if (last === undefined) return false;
    return this.now() - last < this.deps.alerts.cooldownMs;
  }

  private familyInCooldown(familyHash: string, nowMs: number): boolean {
    const last = this.lastFiredFamily.get(familyHash);
    if (last === undefined) return false;
    return nowMs - last < this.deps.alerts.cooldownMs;
  }

  /** Build the v1-compatible payload for an interval (rate) rule. */
  private buildRatePayload(rule: AlertRule, value: number, threshold: number): AlertPayload {
    return {
      rule,
      value,
      threshold,
      firedAt: new Date(this.now()).toISOString(),
      instanceId: this.deps.instanceId,
      ...(this.deps.alerts.dashboardUrl !== null
        ? { dashboardUrl: this.deps.alerts.dashboardUrl }
        : {}),
    };
  }

  /**
   * Build the rich `new-exception` payload. Pulls the exception's own fields, then
   * fetches its batch to find the sibling REQUEST entry for route/method/status/
   * duration/user context, and counts how many times this family appears in the
   * trailing window. This is the ONLY expensive path and runs only on a real fire.
   */
  private async buildNewExceptionPayload(
    rule: { type: 'new-exception'; window: string },
    entry: Entry,
    windowMs: number,
    nowMs: number,
  ): Promise<AlertPayload> {
    const occurrences = await this.countFamilyInWindow(entry.type, entry.familyHash, windowMs);
    const context =
      entry.type === EntryType.ClientException
        ? this.buildClientContext(entry, occurrences)
        : await this.buildServerContext(entry, occurrences);

    // Auto-mode AI enrichment: briefly await a diagnosis for this family. The
    // hook caps its own wait, so this never holds the alert beyond the grace.
    const diagnosis =
      this.deps.diagnosisFor !== undefined && entry.familyHash !== null
        ? await this.deps.diagnosisFor(entry.familyHash).catch(() => null)
        : null;

    return {
      rule,
      value: occurrences,
      threshold: 1,
      firedAt: new Date(nowMs).toISOString(),
      instanceId: this.deps.instanceId,
      exception: context,
      ...(this.deps.alerts.dashboardUrl !== null
        ? { dashboardUrl: this.deps.alerts.dashboardUrl }
        : {}),
      ...(diagnosis !== null ? { diagnosis } : {}),
    };
  }

  /**
   * Build the server-exception context: the exception's own fields plus its
   * sibling REQUEST entry (route/method/status/duration/user) from the same batch.
   */
  private async buildServerContext(
    entry: Entry,
    occurrences: number,
  ): Promise<ExceptionAlertContext> {
    const exceptionContent = asPartialExceptionContent(entry.content);
    const request = await this.findSiblingRequest(entry.batchId);
    const requestContent = request === null ? null : asPartialRequestContent(request.content);
    return {
      familyHash: entry.familyHash ?? '',
      class: typeof exceptionContent.class === 'string' ? exceptionContent.class : 'Error',
      message: typeof exceptionContent.message === 'string' ? exceptionContent.message : '',
      stack: clipStackFrames(
        typeof exceptionContent.stack === 'string' ? exceptionContent.stack : null,
      ),
      route:
        requestContent !== null && typeof requestContent.uri === 'string'
          ? requestContent.uri
          : null,
      method:
        requestContent !== null && typeof requestContent.method === 'string'
          ? requestContent.method
          : null,
      userAgent: null,
      client: false,
      statusCode:
        requestContent !== null && typeof requestContent.statusCode === 'number'
          ? requestContent.statusCode
          : null,
      durationMs: request?.durationMs ?? null,
      user: userFromTags(request?.tags ?? entry.tags),
      occurrences,
      entryId: entry.id,
      batchId: entry.batchId,
    };
  }

  /**
   * Build the client-exception context from the browser-reported content. There's
   * no sibling request (the error came straight from the browser), so `route` is
   * the page `url`, `method`/`statusCode`/`durationMs` are null, and `userAgent`
   * carries the reporting browser. The user comes from the entry's own
   * `user:<id>` tag (the controller tagged it at record time).
   */
  private buildClientContext(entry: Entry, occurrences: number): ExceptionAlertContext {
    const content = asPartialClientExceptionContent(entry.content);
    return {
      familyHash: entry.familyHash ?? '',
      class: typeof content.name === 'string' ? content.name : 'Error',
      message: typeof content.message === 'string' ? content.message : '',
      stack: clipStackFrames(typeof content.stack === 'string' ? content.stack : null),
      route: typeof content.url === 'string' ? content.url : null,
      method: null,
      userAgent: typeof content.userAgent === 'string' ? content.userAgent : null,
      client: true,
      statusCode: null,
      durationMs: null,
      user: userFromTags(entry.tags),
      occurrences,
      entryId: entry.id,
      batchId: entry.batchId,
    };
  }

  /** Find the sibling REQUEST entry in the exception's batch (or `null`). */
  private async findSiblingRequest(batchId: string): Promise<Entry | null> {
    const batch = await this.deps.storage.batch(batchId);
    return batch.find((member) => member.type === EntryType.Request) ?? null;
  }

  /** Count entries of this family AND type in the trailing window (>= 1). */
  private async countFamilyInWindow(
    type: string,
    familyHash: string | null,
    windowMs: number,
  ): Promise<number> {
    if (familyHash === null) return 1;
    const after = new Date(this.now() - windowMs);
    const result = await collectEntriesInWindow(
      this.deps.storage,
      { type, familyHash, after, omitContent: true },
      { scanCap: ALERT_SCAN_CAP },
    );
    // The just-stored occurrence is included; never report fewer than 1.
    return Math.max(1, result.entries.length);
  }

  /**
   * Fan the payload out to every channel concurrently. Each channel's failure is
   * isolated (`Promise.allSettled`) and warn-logged ONCE per channel name so a
   * persistently-down destination doesn't flood the logs. Never rejects.
   */
  private async dispatch(payload: AlertPayload): Promise<void> {
    const results = await Promise.allSettled(
      this.deps.alerts.channels.map((channel) => channel.send(payload)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.warnChannelFailure(this.deps.alerts.channels[index], result.reason);
      }
    });
  }

  /** Warn once per channel name; subsequent failures for that channel are silent. */
  private warnChannelFailure(channel: AlertChannel | undefined, reason: unknown): void {
    if (channel === undefined) return;
    if (this.warnedChannels.has(channel.name)) return;
    this.warnedChannels.add(channel.name);
    const message = reason instanceof Error ? reason.message : String(reason);
    this.logger.warn(`Telescope alert channel '${channel.name}' failed: ${message}`);
  }
}

/** A non-null object narrowed to a string-keyed record (else an empty record),
 *  so content fields can be read without a cast. */
function asContentRecord(content: unknown): Record<string, unknown> {
  return typeof content === 'object' && content !== null ? { ...content } : {};
}

function asPartialExceptionContent(content: unknown): Partial<ExceptionContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.class === 'string' ? { class: record.class } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
  };
}

function asPartialRequestContent(content: unknown): Partial<RequestContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.uri === 'string' ? { uri: record.uri } : {}),
    ...(typeof record.method === 'string' ? { method: record.method } : {}),
    ...(typeof record.statusCode === 'number' ? { statusCode: record.statusCode } : {}),
  };
}

function asPartialClientExceptionContent(content: unknown): Partial<ClientExceptionContent> {
  const record = asContentRecord(content);
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
    ...(typeof record.url === 'string' ? { url: record.url } : {}),
    ...(typeof record.userAgent === 'string' ? { userAgent: record.userAgent } : {}),
  };
}

/** Keep at most the first N stack frames; `null` passes through. */
function clipStackFrames(stack: string | null): string | null {
  if (stack === null) return null;
  return stack.split('\n').slice(0, ALERT_STACK_FRAME_LIMIT).join('\n');
}

/** Extract the user id from a `user:<id>` tag, or `null` when none is present. */
function userFromTags(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith('user:')) {
      return tag.slice('user:'.length);
    }
  }
  return null;
}
