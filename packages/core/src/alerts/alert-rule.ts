// packages/core/src/alerts/alert-rule.ts

/**
 * A single alerting rule. Each rule is evaluated on every tick of the alerter.
 *
 * - `exception-rate`    — fires when `>= threshold` exception entries were
 *                         recorded in the trailing `window`.
 * - `slow-request-rate` — fires when `>= count` request entries slower than
 *                         `thresholdMs` were recorded in the trailing `window`.
 * - `dropped-entries`   — fires when the Recorder's cumulative `droppedCount`
 *                         grew by `>= threshold` since the previous evaluation
 *                         (a delta, not an absolute — so a once-busy host that
 *                         dropped a burst at boot doesn't keep re-firing).
 */
export type AlertRule =
  | { type: 'exception-rate'; window: string; threshold: number }
  | { type: 'slow-request-rate'; window: string; thresholdMs: number; count: number }
  | { type: 'dropped-entries'; threshold: number };

/**
 * Webhook-only alerting (v1). When set, {@link TelescopeAlerter} evaluates
 * `rules` on an unref'd interval and POSTs a JSON payload to `webhookUrl` when a
 * rule fires (and is not within its cooldown). A configured `alerts` with an
 * empty `webhookUrl` or empty `rules` is a fail-closed boot error.
 */
export interface AlertsOptions {
  /** POSTed JSON to this URL when a rule fires (e.g. a Slack incoming webhook). */
  webhookUrl: string;
  /**
   * Evaluation cadence as a duration string (e.g. `'1m'`). Default `'1m'`.
   * Resolved to ms via `durationToMs`.
   */
  every?: string;
  /** Re-notify suppression per rule, as a duration string. Default `'15m'`. */
  cooldown?: string;
  /** Rules to evaluate. Must be non-empty when `alerts` is set. */
  rules: AlertRule[];
}

/** Boot-resolved, validated alerting config (durations normalized to ms). */
export interface ResolvedAlerts {
  webhookUrl: string;
  intervalMs: number;
  cooldownMs: number;
  rules: AlertRule[];
}

/** Shape POSTed to the webhook when a rule fires. */
export interface AlertPayload {
  rule: AlertRule;
  /** The measured value that crossed the threshold. */
  value: number;
  /** The rule's threshold (`threshold` or `count`, per rule kind). */
  threshold: number;
  /** ISO-8601 fire time. */
  firedAt: string;
  /** The reporting instance (`config.instanceId`). */
  instanceId: string;
}
