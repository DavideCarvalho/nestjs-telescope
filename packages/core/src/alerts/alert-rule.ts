// packages/core/src/alerts/alert-rule.ts
import type { AlertChannel } from './alert-channel.js';

/**
 * A single alerting rule. Each rule is evaluated on every tick of the alerter,
 * EXCEPT `new-exception` which evaluates per-flush over just-stored exception
 * entries (so a brand-new error family pages you within a flush interval, not a
 * full evaluation interval).
 *
 * - `exception-rate`    — fires when `>= threshold` exception entries were
 *                         recorded in the trailing `window`.
 * - `slow-request-rate` — fires when `>= count` request entries slower than
 *                         `thresholdMs` were recorded in the trailing `window`.
 * - `dropped-entries`   — fires when the Recorder's cumulative `droppedCount`
 *                         grew by `>= threshold` since the previous evaluation
 *                         (a delta, not an absolute — so a once-busy host that
 *                         dropped a burst at boot doesn't keep re-firing).
 * - `new-exception`     — fires the FIRST time an exception's `familyHash` is
 *                         seen within `window` (a genuinely NEW error family).
 *                         Dedup is an in-memory, per-replica seen-map, so the
 *                         same family may alert ONCE PER POD in a multi-replica
 *                         deployment (acceptable for v1 — see docs).
 */
export type AlertRule =
  | { type: 'exception-rate'; window: string; threshold: number }
  | { type: 'slow-request-rate'; window: string; thresholdMs: number; count: number }
  | { type: 'dropped-entries'; threshold: number }
  | { type: 'new-exception'; window: string };

/**
 * Pluggable alerting (v2). When set, {@link TelescopeAlerter} evaluates `rules`
 * and fans each fired alert out to EVERY configured channel concurrently. A
 * configured `alerts` with no destination (neither `channels` nor the legacy
 * `webhookUrl`) or empty `rules` is a fail-closed boot error.
 */
export interface AlertsOptions {
  /**
   * Delivery destinations. Each fired alert is sent to every channel
   * concurrently; one channel failing never blocks the others. Use the factory
   * helpers: `slackChannel(url)`, `webhookChannel(url)`, `customChannel(fn)`.
   * Optional ONLY for backward compatibility with `webhookUrl` — supply at least
   * one of `channels` / `webhookUrl`.
   */
  channels?: AlertChannel[];
  /**
   * Legacy single raw-JSON webhook (v1). Still accepted: internally rewritten
   * into a `webhookChannel(webhookUrl)` and appended to `channels`. Prefer
   * `channels` for new configs.
   */
  webhookUrl?: string;
  /**
   * The host's EXTERNAL Telescope dashboard URL (e.g.
   * `https://telescope.example.com/telescope/`). When set, channels that support
   * deep links (Slack) build a link straight to the offending entry, e.g.
   * `${dashboardUrl}#/entries/exception/${id}`. Optional; without it the Slack
   * message simply omits the "Open in Telescope" button.
   */
  dashboardUrl?: string;
  /**
   * Evaluation cadence as a duration string (e.g. `'1m'`). Default `'1m'`.
   * Resolved to ms via `durationToMs`. (Interval rules only; `new-exception`
   * evaluates per-flush.)
   */
  every?: string;
  /** Re-notify suppression per rule, as a duration string. Default `'15m'`. */
  cooldown?: string;
  /** Rules to evaluate. Must be non-empty when `alerts` is set. */
  rules: AlertRule[];
}

/** Boot-resolved, validated alerting config (durations normalized to ms). */
export interface ResolvedAlerts {
  /** All destinations, with any legacy `webhookUrl` already folded in. */
  channels: AlertChannel[];
  /** External dashboard URL for deep links, or `null` when unset. */
  dashboardUrl: string | null;
  intervalMs: number;
  cooldownMs: number;
  rules: AlertRule[];
}

/**
 * Rich exception context attached to a `new-exception` alert. Pulled from the
 * exception entry AND its sibling request entry in the SAME batch (queried by
 * `batchId` only when the rule actually fires, so the common no-fire path stays
 * a single in-memory map lookup). Absent on rate-rule alerts.
 */
export interface ExceptionAlertContext {
  /** Stable family hash that was first-seen this window. */
  familyHash: string;
  /** Exception class name (e.g. `TypeError`). */
  class: string;
  /** Exception message. */
  message: string;
  /** Truncated stack (first frames), or `null`. */
  stack: string | null;
  /**
   * Where the error happened: the sibling request's route/uri for a server
   * exception, or the browser page `url` for a `client_exception`. `null` when
   * neither is available.
   */
  route: string | null;
  /** Request method, or `null` (always `null` for a client_exception). */
  method: string | null;
  /**
   * Reporting browser's user-agent — present ONLY for a `client_exception`
   * (front-end errors carry no server route/method but do carry a UA). `null`
   * for server exceptions.
   */
  userAgent: string | null;
  /** True when this alert is a browser-reported `client_exception`. */
  client: boolean;
  /** Response status code, or `null`. */
  statusCode: number | null;
  /** Request duration (ms), or `null`. */
  durationMs: number | null;
  /** Authenticated user id from a `user:<id>` tag, or `null`. */
  user: string | null;
  /** Times this family was seen in the window (>= 1; 1 on first-occurrence). */
  occurrences: number;
  /** Exception entry id (for the dashboard deep link). */
  entryId: string;
  /** Batch id that ties the exception to its request entry. */
  batchId: string;
}

/**
 * Shape delivered to channels when a rule fires. BACKWARD COMPATIBLE with the v1
 * raw-webhook JSON: every v1 field (`rule`, `value`, `threshold`, `firedAt`,
 * `instanceId`) is unchanged; new fields are purely additive and optional.
 */
export interface AlertPayload {
  rule: AlertRule;
  /** The measured value that crossed the threshold. */
  value: number;
  /** The rule's threshold (`threshold`/`count`, or `1` for `new-exception`). */
  threshold: number;
  /** ISO-8601 fire time. */
  firedAt: string;
  /** The reporting instance (`config.instanceId`). */
  instanceId: string;
  /** Rich context for `new-exception` alerts; absent for rate rules. */
  exception?: ExceptionAlertContext;
  /** External dashboard URL when configured (lets channels build deep links). */
  dashboardUrl?: string;
  /**
   * AI-generated probable-cause markdown for a `new-exception` alert, attached
   * when `ai` is configured in `'auto'` mode AND the diagnosis finished within
   * the alert's short grace window. Absent when AI is off, the diagnosis was
   * still running at dispatch time, or it failed — the alert always fires
   * regardless, AI is purely additive. Channels that render it (Slack) append a
   * "Probable cause (AI)" section.
   */
  diagnosis?: string;
}
