import { durationToMs } from '../config/parse-duration.js';
// packages/core/src/alerts/resolve-alerts.ts
import type { AlertChannel } from './alert-channel.js';
import type { AlertsOptions, ResolvedAlerts } from './alert-rule.js';
import { validateHeartbeat } from './integrations/heartbeats.js';
import { validateStatusPage } from './integrations/status-pages.js';

const DEFAULT_INTERVAL = '1m';
const DEFAULT_COOLDOWN = '15m';

/**
 * Validate + normalize `alerts`. Returns `null` when unconfigured (feature off).
 *
 * Fails CLOSED at boot:
 *  - a configured `alerts` with NO `channels` throws (silently dropping every
 *    alert is worse than refusing to boot);
 *  - empty `rules` throws, unless `heartbeats`/`statusPages` make it an
 *    uptime-only setup (then `channels` may be empty too);
 *  - a heartbeat / status page missing its URL, key or components throws;
 *  - an unparseable `every`/`cooldown`/rule-`window` duration throws (a typo
 *    surfaces at boot rather than silently never firing).
 */
export function resolveAlerts(alerts: AlertsOptions | undefined): ResolvedAlerts | null {
  if (alerts === undefined) {
    return null;
  }
  const rules = Array.isArray(alerts.rules) ? alerts.rules : [];
  const heartbeats = Array.isArray(alerts.heartbeats) ? alerts.heartbeats : [];
  const statusPages = Array.isArray(alerts.statusPages) ? alerts.statusPages : [];
  const uptimeOnly = heartbeats.length > 0 || statusPages.length > 0;
  if (rules.length === 0 && !uptimeOnly) {
    throw new Error('Telescope alerts: `rules` is required and must be non-empty.');
  }

  const channels: AlertChannel[] = [...(alerts.channels ?? [])];
  if (channels.length === 0 && rules.length > 0) {
    throw new Error(
      'Telescope alerts: at least one destination is required — set `channels` ' +
        '(e.g. slackChannel/webhookChannel/customChannel).',
    );
  }

  // Uptime integrations fail closed too: a missing key or a malformed URL
  // throws at boot (the message names the field, never the secret).
  for (const heartbeat of heartbeats) validateHeartbeat(heartbeat);
  for (const page of statusPages) validateStatusPage(page);

  // A rule routed to a channel name nobody has would silently never deliver.
  const names = new Set(channels.map((channel) => channel.name));
  for (const rule of rules) {
    for (const name of rule.channels ?? []) {
      if (!names.has(name)) {
        throw new Error(
          `Telescope alerts: rule '${rule.type}' routes to channel '${name}', but no channel has that name.`,
        );
      }
    }
  }

  for (const rule of rules) {
    if (
      rule.type === 'exception-rate' ||
      rule.type === 'slow-request-rate' ||
      rule.type === 'new-exception' ||
      rule.type === 'metric-threshold'
    ) {
      // Throws on an unparseable window — fail closed at boot.
      durationToMs(rule.window);
    }
    // `every-exception`'s window is optional (occurrence-count only); validate it
    // when present so a typo fails at boot rather than silently mis-counting.
    if (rule.type === 'every-exception' && rule.window !== undefined) {
      durationToMs(rule.window);
    }
    if (rule.type === 'entries-dropped') {
      durationToMs(rule.window);
      if (rule.threshold !== undefined && !(rule.threshold >= 1)) {
        throw new Error('Telescope alerts: `entries-dropped` needs a `threshold` of 1 or more.');
      }
    }
    if (rule.type === 'check-down') durationToMs(rule.for);
    if (rule.type === 'instances-up') {
      if (rule.for !== undefined) durationToMs(rule.for);
      if (typeof rule.below !== 'number' || !(rule.below > 0)) {
        throw new Error('Telescope alerts: `instances-up` needs `below`, a number above 0.');
      }
    }
  }

  return {
    channels,
    dashboardUrl:
      typeof alerts.dashboardUrl === 'string' && alerts.dashboardUrl.trim() !== ''
        ? alerts.dashboardUrl
        : null,
    intervalMs: durationToMs(alerts.every ?? DEFAULT_INTERVAL),
    cooldownMs: durationToMs(alerts.cooldown ?? DEFAULT_COOLDOWN),
    rules,
    geoLookup: typeof alerts.geoLookup === 'function' ? alerts.geoLookup : null,
    app: typeof alerts.app === 'string' && alerts.app.trim() !== '' ? alerts.app : null,
    heartbeats,
    statusPages,
    checkStates: typeof alerts.checkStates === 'function' ? alerts.checkStates : null,
  };
}
