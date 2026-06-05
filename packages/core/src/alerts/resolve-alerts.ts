import { durationToMs } from '../config/parse-duration.js';
// packages/core/src/alerts/resolve-alerts.ts
import { type AlertChannel, webhookChannel } from './alert-channel.js';
import type { AlertsOptions, ResolvedAlerts } from './alert-rule.js';

const DEFAULT_INTERVAL = '1m';
const DEFAULT_COOLDOWN = '15m';

/**
 * Validate + normalize `alerts`. Returns `null` when unconfigured (feature off).
 *
 * Fails CLOSED at boot:
 *  - a configured `alerts` with NO destination — neither `channels` nor the
 *    legacy `webhookUrl` — throws (silently dropping every alert is worse than
 *    refusing to boot);
 *  - empty `rules` throws;
 *  - an unparseable `every`/`cooldown`/rule-`window` duration throws (a typo
 *    surfaces at boot rather than silently never firing).
 *
 * The legacy `webhookUrl` is folded into the channel list as a
 * {@link webhookChannel}, APPENDED after any explicit `channels`, so the v1
 * raw-JSON behavior is preserved exactly while new configs use `channels`.
 */
export function resolveAlerts(alerts: AlertsOptions | undefined): ResolvedAlerts | null {
  if (alerts === undefined) {
    return null;
  }
  if (!Array.isArray(alerts.rules) || alerts.rules.length === 0) {
    throw new Error('Telescope alerts: `rules` is required and must be non-empty.');
  }

  const channels: AlertChannel[] = [...(alerts.channels ?? [])];
  // Legacy compat: a top-level `webhookUrl` becomes a raw-JSON webhook channel.
  if (typeof alerts.webhookUrl === 'string' && alerts.webhookUrl.trim() !== '') {
    channels.push(webhookChannel(alerts.webhookUrl));
  }
  if (channels.length === 0) {
    throw new Error(
      'Telescope alerts: at least one destination is required — set `channels` ' +
        '(e.g. slackChannel/webhookChannel/customChannel) or the legacy `webhookUrl`.',
    );
  }

  for (const rule of alerts.rules) {
    if (
      rule.type === 'exception-rate' ||
      rule.type === 'slow-request-rate' ||
      rule.type === 'new-exception'
    ) {
      // Throws on an unparseable window — fail closed at boot.
      durationToMs(rule.window);
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
    rules: alerts.rules,
  };
}
