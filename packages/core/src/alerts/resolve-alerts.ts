// packages/core/src/alerts/resolve-alerts.ts
import { durationToMs } from '../config/parse-duration.js';
import type { AlertsOptions, ResolvedAlerts } from './alert-rule.js';

const DEFAULT_INTERVAL = '1m';
const DEFAULT_COOLDOWN = '15m';

/**
 * Validate + normalize `alerts`. Returns `null` when unconfigured (feature off).
 * Fails CLOSED at boot: a configured `alerts` with a missing/empty `webhookUrl`
 * or empty `rules` throws, and an unparseable `every`/`cooldown` duration throws
 * (via `durationToMs`). Window durations on individual rules are validated here
 * too so a typo surfaces at boot rather than silently never firing.
 */
export function resolveAlerts(alerts: AlertsOptions | undefined): ResolvedAlerts | null {
  if (alerts === undefined) {
    return null;
  }
  if (typeof alerts.webhookUrl !== 'string' || alerts.webhookUrl.trim() === '') {
    throw new Error('Telescope alerts: `webhookUrl` is required and must be non-empty.');
  }
  if (!Array.isArray(alerts.rules) || alerts.rules.length === 0) {
    throw new Error('Telescope alerts: `rules` is required and must be non-empty.');
  }
  for (const rule of alerts.rules) {
    if (rule.type === 'exception-rate' || rule.type === 'slow-request-rate') {
      // Throws on an unparseable window — fail closed at boot.
      durationToMs(rule.window);
    }
  }
  return {
    webhookUrl: alerts.webhookUrl,
    intervalMs: durationToMs(alerts.every ?? DEFAULT_INTERVAL),
    cooldownMs: durationToMs(alerts.cooldown ?? DEFAULT_COOLDOWN),
    rules: alerts.rules,
  };
}
