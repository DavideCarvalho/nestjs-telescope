// packages/core/src/alerts/integrations/incident.ts
import { createHash } from 'node:crypto';
import type { AlertChannel } from '../alert-channel.js';
import type { AlertPayload, AlertRule, AlertSeverity } from '../alert-rule.js';

/**
 * What every integration derives from an {@link AlertPayload}: one incident key
 * per rule + service (so one incident is never paged twice), a severity, and a
 * short human title/summary.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

/**
 * Default severity per rule kind. Kinds not listed here (including rule kinds a
 * newer release adds) fall back to `error`.
 */
const DEFAULT_SEVERITY: Record<string, AlertSeverity> = {
  'new-exception': 'error',
  'every-exception': 'error',
  'exception-rate': 'critical',
  'slow-request-rate': 'warning',
  'dropped-entries': 'warning',
  'metric-threshold': 'warning',
  // Fleet rules: an app with too few instances or a down check is an outage; a restart loop is
  // an error; a tenant dropping entries loses data, not users.
  'instances-up': 'critical',
  'check-down': 'critical',
  'restart-loop': 'error',
  'entries-dropped': 'warning',
};

/** The rule's own `severity`, else the default for its kind. */
export function severityOf(alert: AlertPayload): AlertSeverity {
  return alert.rule.severity ?? DEFAULT_SEVERITY[alert.rule.type] ?? 'error';
}

/** `true` when `severity` is at least `min`. */
export function meetsSeverity(severity: AlertSeverity, min: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** `firing` unless the payload says it resolves a raised alert. */
export function statusOf(alert: AlertPayload): 'firing' | 'resolved' {
  return alert.status ?? 'firing';
}

/**
 * The service an alert is about: the fleet app a fleet rule is about, else `alerts.app` when set,
 * else the reporting instance.
 */
export function appOf(alert: AlertPayload): string {
  if (alert.fleet !== undefined && alert.fleet.app !== '') return alert.fleet.app;
  return alert.app !== undefined && alert.app !== '' ? alert.app : alert.instanceId;
}

/**
 * The stable identity of a rule, independent of the value it measured — so the
 * firing and the resolving notification of the same rule share it.
 */
function ruleIdentity(rule: AlertRule): string {
  const parts: string[] = [rule.type];
  const loose: Record<string, unknown> = { ...rule };
  for (const field of [
    'metric',
    'comparator',
    'threshold',
    'thresholdMs',
    'count',
    'window',
    'below',
    'for',
  ]) {
    const value = loose[field];
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
  }
  return parts.join(':');
}

/**
 * The deduplication key for an alert: `telescope:<app>:<rule>[:<exception family>]`, and for a
 * fleet rule `telescope:<fleet app>:<rule>[:<check>][:<host>]`, so each fleet subject (an app, an
 * app's check, a looping host) is its own incident and its resolve closes that one.
 * PagerDuty's `dedup_key`, Opsgenie's `alias`, incident.io's `deduplication_key`
 * and Grafana OnCall's `alert_uid` all use it, so a trigger repeated while the
 * incident is open is folded into it, and the resolve closes the right one.
 */
export function incidentKey(alert: AlertPayload): string {
  const parts = [`telescope:${appOf(alert)}:${ruleIdentity(alert.rule)}`];
  const family = alert.exception?.familyHash;
  if (family !== undefined) parts.push(family);
  if (alert.fleet?.check !== undefined) parts.push(alert.fleet.check);
  if (alert.fleet?.host !== undefined) parts.push(alert.fleet.host);
  return parts.join(':');
}

/**
 * {@link incidentKey} capped at `max` characters for providers with a key
 * limit (PagerDuty `dedup_key` 255, Opsgenie `alias` 512). An over-long key
 * keeps its head and ends in a hash of the whole key, so it stays unique and
 * the trigger and the resolve still compute the same value.
 */
export function boundedIncidentKey(alert: AlertPayload, max: number): string {
  const key = incidentKey(alert);
  if (key.length <= max) return key;
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return `${key.slice(0, Math.max(0, max - digest.length - 1))}:${digest}`;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** One-line title, e.g. `[error] api: TypeError: cannot read x (POST /checkout)`. */
export function titleOf(alert: AlertPayload): string {
  const prefix = statusOf(alert) === 'resolved' ? '[resolved]' : `[${severityOf(alert)}]`;
  const app = appOf(alert);
  if (alert.exception !== undefined) {
    const { class: cls, message, route, method } = alert.exception;
    const where = route !== null ? ` (${method !== null ? `${method} ` : ''}${route})` : '';
    return `${prefix} ${app}: ${cls}: ${message}${where}`;
  }
  if (alert.fleet !== undefined) return `${prefix} ${app}: ${alert.fleet.detail}`;
  const what = alert.rule.type === 'metric-threshold' ? alert.rule.metric : alert.rule.type;
  return `${prefix} ${app}: ${what} = ${formatValue(alert.value)} (threshold ${formatValue(alert.threshold)})`;
}

/** Plain-text multi-line body for channels without rich formatting. */
export function summaryLines(alert: AlertPayload): string[] {
  const lines = [
    `Rule: ${alert.rule.type}`,
    `App: ${appOf(alert)}`,
    `Instance: ${alert.instanceId}`,
    `Severity: ${severityOf(alert)}`,
    `Status: ${statusOf(alert)}`,
    `Value: ${formatValue(alert.value)} (threshold ${formatValue(alert.threshold)})`,
    `At: ${alert.firedAt}`,
  ];
  if (alert.fleet !== undefined) {
    if (alert.fleet.check !== undefined) lines.push(`Check: ${alert.fleet.check}`);
    if (alert.fleet.host !== undefined) lines.push(`Host: ${alert.fleet.host}`);
    lines.push(`Detail: ${alert.fleet.detail}`);
  }
  const ex = alert.exception;
  if (ex !== undefined) {
    lines.push(`Occurrences in window: ${ex.occurrences}`);
    if (ex.statusCode !== null) lines.push(`Status code: ${ex.statusCode}`);
    if (ex.user !== null) lines.push(`User: ${ex.user}`);
  }
  if (alert.diagnosis !== undefined)
    lines.push(`Probable cause (AI): ${clip(alert.diagnosis, 1500)}`);
  const link = linkOf(alert);
  if (link !== null) lines.push(`Open in Telescope: ${link}`);
  return lines;
}

/**
 * Deep link to the dashboard: the entry detail route (`#/entries/view/:id`,
 * the same one the Slack channel uses) when the alert carries an exception,
 * else the dashboard root. `null` without a `dashboardUrl`.
 */
export function linkOf(alert: AlertPayload): string | null {
  if (alert.dashboardUrl === undefined) return null;
  const base = alert.dashboardUrl.replace(/\/+$/, '');
  if (alert.exception !== undefined) return `${base}#/entries/view/${alert.exception.entryId}`;
  return base;
}

/**
 * Structured details for providers with a free-form `details` field: everything
 * the payload carries except the full stack (sent clipped).
 */
export function detailsOf(alert: AlertPayload): Record<string, unknown> {
  const details: Record<string, unknown> = {
    rule: alert.rule.type,
    app: appOf(alert),
    instance: alert.instanceId,
    severity: severityOf(alert),
    status: statusOf(alert),
    value: alert.value,
    threshold: alert.threshold,
    firedAt: alert.firedAt,
  };
  if (alert.rule.type === 'metric-threshold') details.metric = alert.rule.metric;
  if (alert.fleet !== undefined) details.fleet = { ...alert.fleet };
  const ex = alert.exception;
  if (ex !== undefined) {
    details.exception = ex.class;
    details.message = ex.message;
    details.route = ex.route;
    details.method = ex.method;
    details.statusCode = ex.statusCode;
    details.occurrences = ex.occurrences;
    details.familyHash = ex.familyHash;
    if (ex.user !== null) details.user = ex.user;
    if (ex.stack !== null) details.stack = clip(ex.stack, 2000);
  }
  if (alert.diagnosis !== undefined) details.diagnosis = clip(alert.diagnosis, 4000);
  const link = linkOf(alert);
  if (link !== null) details.link = link;
  return details;
}

/** Clip `text` to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Options every built-in integration channel accepts. */
export interface ChannelRouting {
  /** Channel name used for per-rule routing and failure logs. Defaults to the type. */
  name?: string;
  /** Only alerts at or above this severity reach the channel. Default: all. */
  minSeverity?: AlertSeverity;
  /**
   * Also send the `resolved` notification when a firing interval rule stops
   * crossing its threshold. Default `true` for every built-in integration.
   */
  notifyResolved?: boolean;
}

/** Build the {@link AlertChannel} shell every integration shares. */
export function integrationChannel(
  type: string,
  options: ChannelRouting,
  send: (alert: AlertPayload) => Promise<void>,
): AlertChannel {
  return {
    name: options.name ?? type,
    ...(options.minSeverity !== undefined ? { minSeverity: options.minSeverity } : {}),
    acceptsResolved: options.notifyResolved ?? true,
    send,
  };
}

/**
 * Whether `channel` should receive `alert`: the rule's `channels` list (when set)
 * must name it, the alert must meet the channel's `minSeverity`, and a
 * `resolved` notification only goes to channels that accept it.
 */
export function routesTo(alert: AlertPayload, channel: AlertChannel): boolean {
  const ruleChannels = alert.rule.channels;
  if (Array.isArray(ruleChannels) && !ruleChannels.includes(channel.name)) return false;
  if (channel.minSeverity !== undefined && !meetsSeverity(severityOf(alert), channel.minSeverity)) {
    return false;
  }
  if (statusOf(alert) === 'resolved' && channel.acceptsResolved !== true) return false;
  return true;
}

/** Throw at boot when a required option is missing. Names the field, never its value. */
export function requireFields(channel: string, options: object, fields: readonly string[]): void {
  const record: Record<string, unknown> = { ...options };
  const missing = fields.filter((field) => {
    const value = record[field];
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0)
    );
  });
  if (missing.length > 0) {
    throw new Error(`Telescope alert channel '${channel}': missing ${missing.join(', ')}`);
  }
}
