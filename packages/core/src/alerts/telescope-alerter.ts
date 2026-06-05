// packages/core/src/alerts/telescope-alerter.ts
import { Logger } from '@nestjs/common';
import { durationToMs } from '../config/parse-duration.js';
import { EntryType } from '../entry/entry.js';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { AlertPayload, AlertRule, ResolvedAlerts } from './alert-rule.js';

/**
 * Cap on entries scanned per windowed rule read. Alerting is a coarse "did we
 * cross N" check, not analytics — a small cap keeps each tick cheap even on a
 * busy store. Counts at/above the cap still cross any sane threshold, so the cap
 * never hides a firing condition (it only under-counts far above threshold).
 */
const ALERT_SCAN_CAP = 10_000;

/** POST timeout for the webhook — never let a hung endpoint stall the alerter. */
const WEBHOOK_TIMEOUT_MS = 5_000;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<unknown>;

export interface TelescopeAlerterDeps {
  alerts: ResolvedAlerts;
  storage: StorageProvider;
  instanceId: string;
  /** Cumulative Recorder drop count reader (delta-based `dropped-entries` rule). */
  droppedCount: () => number;
  /** Wall-clock seam (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable `fetch` seam. Defaults to global `fetch`. */
  fetch?: FetchLike;
  logger?: Logger;
}

/**
 * Webhook-only alerting (v1). Evaluates the configured rules on an unref'd
 * interval; when a rule fires (and is past its per-rule cooldown) it POSTs an
 * {@link AlertPayload} to the webhook. NEVER throws into the host: a webhook
 * failure is warn-logged ONCE per rule kind and otherwise swallowed.
 */
export class TelescopeAlerter {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetch: FetchLike;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-rule last-fired wall time (index-keyed; rules are a fixed array). */
  private readonly lastFiredAt = new Map<number, number>();
  /** Per-rule-kind "already warned about webhook failure" gate. */
  private readonly warnedKinds = new Set<AlertRule['type']>();
  /** Previous cumulative droppedCount, for the `dropped-entries` delta. */
  private lastDroppedCount: number;

  constructor(private readonly deps: TelescopeAlerterDeps) {
    this.logger = deps.logger ?? new Logger(TelescopeAlerter.name);
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.lastDroppedCount = deps.droppedCount();
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
   * Evaluate every rule once. Each rule that fires (and is past cooldown) POSTs
   * independently; one failing webhook never blocks the others. Exposed for the
   * timer and for deterministic tests.
   */
  async evaluate(): Promise<void> {
    for (let index = 0; index < this.deps.alerts.rules.length; index++) {
      const rule = this.deps.alerts.rules[index];
      if (rule === undefined) continue;
      const outcome = await this.measure(rule);
      if (outcome === null) continue;
      if (this.inCooldown(index)) continue;
      this.lastFiredAt.set(index, this.now());
      await this.notify(rule, outcome.value, outcome.threshold);
    }
  }

  /** Returns `{ value, threshold }` when the rule is firing, else `null`. */
  private async measure(rule: AlertRule): Promise<{ value: number; threshold: number } | null> {
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

  /** POST the payload; swallow + warn-once-per-kind on any failure. */
  private async notify(rule: AlertRule, value: number, threshold: number): Promise<void> {
    const payload: AlertPayload = {
      rule,
      value,
      threshold,
      firedAt: new Date(this.now()).toISOString(),
      instanceId: this.deps.instanceId,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await this.fetch(this.deps.alerts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (!this.warnedKinds.has(rule.type)) {
        this.warnedKinds.add(rule.type);
        this.logger.warn(
          `Telescope alert webhook failed for '${rule.type}': ${(error as Error).message}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
