// packages/core/src/alerts/integrations/on-call.ts
import type { AlertChannel } from '../alert-channel.js';
import type { AlertPayload, AlertSeverity } from '../alert-rule.js';
import { type HttpDeps, deliver } from './http.js';
import {
  type ChannelRouting,
  appOf,
  clip,
  detailsOf,
  incidentKey,
  integrationChannel,
  linkOf,
  requireFields,
  severityOf,
  statusOf,
  summaryLines,
  titleOf,
} from './incident.js';

/**
 * Paging / on-call channels. Each keeps the firing → resolved lifecycle: an
 * interval rule (`exception-rate`, `slow-request-rate`, `dropped-entries`,
 * `metric-threshold`) triggers an incident and later resolves the SAME
 * incident, keyed by {@link incidentKey} (one key per rule + app). Exception
 * rules only fire; resolve those in the provider.
 */

/** Options shared by every on-call channel: routing plus retry/timeout knobs. */
export interface OnCallOptions extends ChannelRouting, HttpDeps {}

// ---------------------------------------------------------------------------
// PagerDuty — Events API v2
// ---------------------------------------------------------------------------

export interface PagerDutyOptions extends OnCallOptions {
  /** Integration (routing) key of an Events API v2 integration. */
  routingKey: string;
  /** Events endpoint. Default `https://events.pagerduty.com/v2/enqueue` (EU: `events.eu.pagerduty.com`). */
  url?: string;
  /** `payload.source`. Default: the alert's app. */
  source?: string;
  /** `payload.component`. */
  component?: string;
  /** `payload.group`. */
  group?: string;
}

/** The Events API v2 body for an alert. Telescope's four severities are PagerDuty's. */
export function pagerDutyEvent(
  alert: AlertPayload,
  options: Pick<PagerDutyOptions, 'routingKey' | 'source' | 'component' | 'group'>,
): Record<string, unknown> {
  const dedupKey = incidentKey(alert);
  if (statusOf(alert) === 'resolved') {
    return { routing_key: options.routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  const link = linkOf(alert);
  return {
    routing_key: options.routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      summary: clip(titleOf(alert), 1024),
      source: options.source ?? appOf(alert),
      severity: severityOf(alert),
      timestamp: alert.firedAt,
      ...(options.component !== undefined ? { component: options.component } : {}),
      ...(options.group !== undefined ? { group: options.group } : {}),
      class:
        alert.exception?.class ??
        (alert.rule.type === 'metric-threshold' ? alert.rule.metric : alert.rule.type),
      custom_details: detailsOf(alert),
    },
    ...(link !== null ? { links: [{ href: link, text: 'Open in Telescope' }] } : {}),
    client: 'Telescope',
  };
}

/**
 * PagerDuty via Events API v2: `trigger` on firing, `resolve` on resolved, both
 * with `dedup_key` = {@link incidentKey}, so a repeat trigger joins the open incident.
 */
export function pagerDutyChannel(options: PagerDutyOptions): AlertChannel {
  requireFields('pagerduty', options, ['routingKey']);
  const url = options.url ?? 'https://events.pagerduty.com/v2/enqueue';
  return integrationChannel('pagerduty', options, async (alert) => {
    await deliver({ url, body: pagerDutyEvent(alert, options) }, options);
  });
}

// ---------------------------------------------------------------------------
// Opsgenie — Alert API
// ---------------------------------------------------------------------------

export interface OpsgenieOptions extends OnCallOptions {
  /** API key of an API integration (sent as `Authorization: GenieKey …`). */
  apiKey: string;
  /** `'us'` (default) or `'eu'` — picks `api.opsgenie.com` / `api.eu.opsgenie.com`. */
  region?: 'us' | 'eu';
  /** Responders, e.g. `[{ type: 'team', name: 'backend' }]`. */
  responders?: Array<{ type: 'team' | 'user' | 'escalation' | 'schedule'; name: string }>;
  /** Extra tags. `telescope` and the severity are always added. */
  tags?: string[];
}

const OPSGENIE_PRIORITY: Record<AlertSeverity, string> = {
  critical: 'P1',
  error: 'P2',
  warning: 'P3',
  info: 'P5',
};

/** The create-alert body for an alert (Opsgenie limits: message 130, alias 512, description 15000). */
export function opsgenieAlert(
  alert: AlertPayload,
  options: Pick<OpsgenieOptions, 'responders' | 'tags'> = {},
): Record<string, unknown> {
  const severity = severityOf(alert);
  return {
    message: clip(titleOf(alert), 130),
    alias: clip(incidentKey(alert), 512),
    description: clip(summaryLines(alert).join('\n'), 15000),
    priority: OPSGENIE_PRIORITY[severity],
    source: 'Telescope',
    entity: appOf(alert),
    tags: ['telescope', severity, ...(options.tags ?? [])],
    details: Object.fromEntries(
      Object.entries(detailsOf(alert)).map(([key, value]) => [
        key,
        clip(typeof value === 'string' ? value : JSON.stringify(value), 8000),
      ]),
    ),
    ...(options.responders !== undefined ? { responders: options.responders } : {}),
  };
}

/**
 * Opsgenie: creates an alert with `alias` = {@link incidentKey} (Opsgenie folds
 * repeats into the open alert) and closes it by alias on resolve.
 */
export function opsgenieChannel(options: OpsgenieOptions): AlertChannel {
  requireFields('opsgenie', options, ['apiKey']);
  const base = options.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com';
  const headers = { authorization: `GenieKey ${options.apiKey}` };
  return integrationChannel('opsgenie', options, async (alert) => {
    if (statusOf(alert) === 'resolved') {
      const alias = encodeURIComponent(clip(incidentKey(alert), 512));
      await deliver(
        {
          url: `${base}/v2/alerts/${alias}/close?identifierType=alias`,
          headers,
          body: { source: 'Telescope', note: `Resolved at ${alert.firedAt}` },
        },
        options,
      );
      return;
    }
    await deliver(
      { url: `${base}/v2/alerts`, headers, body: opsgenieAlert(alert, options) },
      options,
    );
  });
}

// ---------------------------------------------------------------------------
// Better Stack — Uptime incidents API
// ---------------------------------------------------------------------------

/** Better Stack's API host (Uptime incidents, heartbeats, status pages). */
export const BETTER_STACK_API = 'https://incidents.betterstack.com';

/** Which Better Stack notification methods an incident uses. */
export interface BetterStackNotify {
  call: boolean;
  sms: boolean;
  email: boolean;
  push: boolean;
}

export interface BetterStackIncidentOptions extends OnCallOptions {
  /** Better Stack Uptime API token. */
  apiToken: string;
  /** Email shown as the incident's requester. Required by Better Stack. */
  requesterEmail: string;
  /** Escalate to this team. */
  teamName?: string;
  /** API base. Default `https://incidents.betterstack.com` (Uptime API v3). */
  baseUrl?: string;
  /**
   * Which notification methods to use. Default: email + push always, call + SMS
   * for `critical` alerts.
   */
  notify?: (severity: AlertSeverity) => BetterStackNotify;
  /** Cap on incidents remembered for resolving. Default `1000`. */
  maxOpen?: number;
}

/** The create-incident body for an alert. */
export function betterStackIncident(
  alert: AlertPayload,
  options: Pick<BetterStackIncidentOptions, 'requesterEmail' | 'teamName' | 'notify'>,
): Record<string, unknown> {
  const severity = severityOf(alert);
  const notify =
    options.notify?.(severity) ??
    (severity === 'critical'
      ? { call: true, sms: true, email: true, push: true }
      : { call: false, sms: false, email: true, push: true });
  return {
    requester_email: options.requesterEmail,
    name: clip(titleOf(alert), 255),
    summary: clip(titleOf(alert), 255),
    description: summaryLines(alert).join('\n'),
    ...notify,
    ...(options.teamName !== undefined ? { team_name: options.teamName } : {}),
  };
}

function readIncidentId(json: unknown): string | null {
  if (json === null || typeof json !== 'object' || !('data' in json)) return null;
  const data = json.data;
  if (data === null || typeof data !== 'object' || !('id' in data)) return null;
  const id = data.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/**
 * Better Stack Uptime: creates an incident on firing and resolves it on resolved.
 * Better Stack has no dedup key, so the channel remembers the open incident per
 * {@link incidentKey} and does not create a second one while it is open. The
 * memory is per process: after a restart, an open incident is resolved by hand.
 */
export function betterStackIncidentChannel(options: BetterStackIncidentOptions): AlertChannel {
  requireFields('betterstack', options, ['apiToken', 'requesterEmail']);
  const base = (options.baseUrl ?? BETTER_STACK_API).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${options.apiToken}` };
  const maxOpen = options.maxOpen ?? 1000;
  const open = new Map<string, string>();
  const pending = new Set<string>();
  return integrationChannel('betterstack', options, async (alert) => {
    const key = incidentKey(alert);
    if (statusOf(alert) === 'resolved') {
      const id = open.get(key);
      if (id === undefined) return;
      await deliver(
        {
          url: `${base}/api/v3/incidents/${encodeURIComponent(id)}/resolve`,
          headers,
          body: { resolved_by: 'Telescope' },
        },
        options,
      );
      open.delete(key);
      return;
    }
    if (open.has(key) || pending.has(key)) return;
    pending.add(key);
    try {
      const result = await deliver(
        { url: `${base}/api/v3/incidents`, headers, body: betterStackIncident(alert, options) },
        options,
      );
      const id = readIncidentId(result.json);
      if (id !== null) {
        if (open.size >= maxOpen) {
          const oldest = open.keys().next().value;
          if (oldest !== undefined) open.delete(oldest);
        }
        open.set(key, id);
      }
    } finally {
      pending.delete(key);
    }
  });
}

// ---------------------------------------------------------------------------
// incident.io — Alert events v2 (HTTP alert source)
// ---------------------------------------------------------------------------

export interface IncidentIoOptions extends OnCallOptions {
  /** The HTTP alert source's config id (the last path segment of its URL). */
  alertSourceConfigId: string;
  /** The alert source's bearer token. */
  token: string;
  /** API base. Default `https://api.incident.io`. */
  baseUrl?: string;
}

/** The alert-event body for an alert. */
export function incidentIoEvent(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  return {
    title: clip(titleOf(alert), 255),
    description: summaryLines(alert).join('\n'),
    deduplication_key: incidentKey(alert),
    status: statusOf(alert),
    ...(link !== null ? { source_url: link } : {}),
    metadata: detailsOf(alert),
  };
}

/** incident.io: `status: firing|resolved` with `deduplication_key` = {@link incidentKey}. */
export function incidentIoChannel(options: IncidentIoOptions): AlertChannel {
  requireFields('incident-io', options, ['alertSourceConfigId', 'token']);
  const base = (options.baseUrl ?? 'https://api.incident.io').replace(/\/+$/, '');
  const url = `${base}/v2/alert_events/http/${encodeURIComponent(options.alertSourceConfigId)}`;
  const headers = { authorization: `Bearer ${options.token}` };
  return integrationChannel('incident-io', options, async (alert) => {
    await deliver({ url, headers, body: incidentIoEvent(alert) }, options);
  });
}

// ---------------------------------------------------------------------------
// Grafana OnCall — formatted webhook integration
// ---------------------------------------------------------------------------

export interface GrafanaOnCallOptions extends OnCallOptions {
  /** The integration's webhook URL (it carries the integration token). */
  url: string;
}

/**
 * The formatted-webhook body for an alert: exactly the fields Grafana OnCall's
 * Formatted Webhook reads (`alert_uid`, `title`, `state`, `message`,
 * `link_to_upstream_details`). It has no severity field, so the severity is in
 * the title (`[critical] …`); route on it with the integration's templates.
 */
export function grafanaOnCallEvent(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  return {
    alert_uid: incidentKey(alert),
    title: titleOf(alert),
    state: statusOf(alert) === 'resolved' ? 'ok' : 'alerting',
    message: summaryLines(alert).join('\n'),
    ...(link !== null ? { link_to_upstream_details: link } : {}),
  };
}

/** Grafana OnCall: `state: alerting|ok` grouped by `alert_uid` = {@link incidentKey}. */
export function grafanaOnCallChannel(options: GrafanaOnCallOptions): AlertChannel {
  requireFields('grafana-oncall', options, ['url']);
  return integrationChannel('grafana-oncall', options, async (alert) => {
    await deliver({ url: options.url, body: grafanaOnCallEvent(alert) }, options);
  });
}
