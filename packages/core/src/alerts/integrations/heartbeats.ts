// packages/core/src/alerts/integrations/heartbeats.ts
import { durationToMs } from '../../config/parse-duration.js';
import {
  type CheckStateSource,
  type UptimeCheckState,
  criticalStates,
  describeProblems,
  readStates,
  statesFor,
  worstStatus,
} from './check-states.js';
import { type HttpDeps, type HttpRequest, deliver } from './http.js';

/**
 * Push uptime monitors (dead man's switches). Telescope pings the provider's URL
 * every `every` ONLY while the app is healthy; when a check is down it pings the
 * provider's fail URL (or skips the ping), and when the process is gone nothing
 * pings at all — either way the provider alerts.
 */

export type HeartbeatProvider =
  | 'healthchecks'
  | 'betterstack'
  | 'cronitor'
  | 'uptime-kuma'
  | 'uptimerobot'
  | 'url';

export interface HeartbeatConfig {
  provider: HeartbeatProvider;
  /** The ping URL for this app (all its checks count). */
  url?: string;
  /**
   * One ping URL per app, pinged while THAT app's checks (states whose `app`
   * matches) are up — for a check-state source that reports several services.
   * An app with no check states is not pinged.
   */
  apps?: Record<string, string>;
  /** Ping cadence. Default `'60s'`. Keep it under the provider's grace period. */
  every?: string;
  /**
   * What to do when a check is down. `'fail'` (default where the provider has a
   * fail signal) reports the failure right away; `'skip'` stops pinging and lets
   * the provider's grace period run out.
   */
  onUnhealthy?: 'fail' | 'skip';
  /** Send the provider's start signal once when monitoring starts (healthchecks.io `/start`, Cronitor `run`). */
  signalStart?: boolean;
  /** Only these check names count. Default: every check. */
  checks?: string[];
  /** Generic provider: URL to call when unhealthy. Without it, `url` heartbeats skip. */
  failUrl?: string;
  /** Name in failure logs. Default: the provider (plus the app). The URL is never logged. */
  name?: string;
}

/** The three requests a provider can make. `null` = the provider has no such signal. */
interface HeartbeatRequests {
  ok: HttpRequest;
  fail: HttpRequest | null;
  start: HttpRequest | null;
}

/** Insert a path suffix before any query string: `…/uuid?x` → `…/uuid/fail?x`. */
function withSuffix(url: string, suffix: string): string {
  const index = url.indexOf('?');
  const path = (index === -1 ? url : url.slice(0, index)).replace(/\/+$/, '');
  return `${path}/${suffix}${index === -1 ? '' : url.slice(index)}`;
}

function withParams(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

/** Build the provider's requests for one ping URL. `message` describes failures. */
export function heartbeatRequests(
  provider: HeartbeatProvider,
  url: string,
  message: string,
  failUrl?: string,
): HeartbeatRequests {
  switch (provider) {
    case 'healthchecks':
      // https://hc-ping.com/<uuid> (or /<ping-key>/<slug>); POST bodies show in the log.
      return {
        ok: { method: 'POST', url, body: message || 'ok' },
        fail: { method: 'POST', url: withSuffix(url, 'fail'), body: message },
        start: { method: 'POST', url: withSuffix(url, 'start'), body: 'telescope started' },
      };
    case 'betterstack':
      // https://incidents.betterstack.com/api/v1/heartbeat/<token>
      return {
        ok: { method: 'GET', url },
        fail: { method: 'POST', url: withSuffix(url, 'fail'), body: message },
        start: null,
      };
    case 'cronitor':
      // https://cronitor.link/p/<api-key>/<monitor-key>
      return {
        ok: { method: 'GET', url: withParams(url, { state: 'complete' }) },
        fail: {
          method: 'GET',
          url: withParams(url, { state: 'fail', message: message.slice(0, 2000) }),
        },
        start: { method: 'GET', url: withParams(url, { state: 'run' }) },
      };
    case 'uptime-kuma':
      // https://kuma.example.com/api/push/<token>
      return {
        ok: { method: 'GET', url: withParams(url, { status: 'up', msg: 'OK' }) },
        fail: {
          method: 'GET',
          url: withParams(url, { status: 'down', msg: message.slice(0, 250) }),
        },
        start: null,
      };
    case 'uptimerobot':
      // https://heartbeat.uptimerobot.com/<id> — no fail signal: unhealthy skips.
      return { ok: { method: 'GET', url }, fail: null, start: null };
    case 'url':
      return {
        ok: { method: 'GET', url },
        fail: failUrl !== undefined ? { method: 'GET', url: failUrl } : null,
        start: null,
      };
  }
}

export interface HeartbeatMonitorDeps extends HttpDeps {
  heartbeats: HeartbeatConfig[];
  /** Check states. Without one, the app counts as healthy while the process runs. */
  source?: CheckStateSource;
  logger?: (message: string) => void;
}

/** What one target did on a tick (tests and logs read it). */
export type HeartbeatOutcome = 'ok' | 'fail' | 'skipped' | 'error';

interface Target {
  config: HeartbeatConfig;
  app: string | null;
  url: string;
  label: string;
  everyMs: number;
  lastAt: number;
}

/**
 * Runs every configured heartbeat on its own cadence. `tick()` is the whole
 * behaviour (tests call it directly); `start()` drives it from one unref'd timer.
 * Never throws: a failed ping is warn-logged once per target until it recovers.
 */
export class HeartbeatMonitor {
  private readonly targets: Target[];
  private readonly logger: (message: string) => void;
  private readonly failing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private started = false;

  constructor(private readonly deps: HeartbeatMonitorDeps) {
    this.logger = deps.logger ?? ((message) => console.warn(message));
    this.targets = deps.heartbeats.flatMap((config) => {
      const everyMs = durationToMs(config.every ?? '60s');
      const base = config.name ?? config.provider;
      const list: Target[] = [];
      if (config.url !== undefined) {
        list.push({
          config,
          app: null,
          url: config.url,
          label: base,
          everyMs,
          lastAt: Number.NEGATIVE_INFINITY,
        });
      }
      for (const [app, url] of Object.entries(config.apps ?? {})) {
        list.push({
          config,
          app,
          url,
          label: `${base}:${app}`,
          everyMs,
          lastAt: Number.NEGATIVE_INFINITY,
        });
      }
      return list;
    });
  }

  /** Shortest cadence across targets — the timer's period. */
  get periodMs(): number {
    return this.targets.reduce((min, target) => Math.min(min, target.everyMs), 60_000);
  }

  start(): void {
    if (this.timer !== null || this.targets.length === 0) return;
    const run = () => {
      this.tick().catch((error: unknown) =>
        this.logger(`Telescope heartbeat tick failed: ${String(error)}`),
      );
    };
    run();
    this.timer = setInterval(run, Math.min(this.periodMs, 15_000));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ping every target that is due. Returns each pinged target's outcome by label. */
  async tick(now: number = Date.now()): Promise<Record<string, HeartbeatOutcome>> {
    if (this.running) return {};
    this.running = true;
    try {
      if (!this.started) {
        this.started = true;
        await this.signalStart();
      }
      const due = this.targets.filter((target) => now - target.lastAt >= target.everyMs);
      if (due.length === 0) return {};
      const states =
        this.deps.source !== undefined ? await readStates(this.deps.source, this.logger) : [];
      const outcomes: Record<string, HeartbeatOutcome> = {};
      await Promise.all(
        due.map(async (target) => {
          target.lastAt = now;
          outcomes[target.label] = await this.ping(target, states);
        }),
      );
      return outcomes;
    } finally {
      this.running = false;
    }
  }

  private async signalStart(): Promise<void> {
    await Promise.all(
      this.targets
        .filter((target) => target.config.signalStart === true)
        .map(async (target) => {
          try {
            let start: HttpRequest | null;
            try {
              start = heartbeatRequests(target.config.provider, target.url, '').start;
            } catch {
              throw new Error('invalid ping URL');
            }
            if (start === null) return;
            await deliver(start, { ...this.deps, retries: 1 });
          } catch (error: unknown) {
            this.warn(target, error);
          }
        }),
    );
  }

  private async ping(target: Target, states: UptimeCheckState[] | null): Promise<HeartbeatOutcome> {
    const { config } = target;
    let relevant: UptimeCheckState[] = [];
    let healthy: boolean;
    if (states === null) {
      healthy = false; // the source failed: health unknown, so don't vouch for it
    } else {
      relevant = statesFor(states, target.app).filter(
        (state) => config.checks === undefined || config.checks.includes(state.name),
      );
      // A per-app target with no states means the app isn't reporting.
      healthy =
        target.app !== null && this.deps.source !== undefined && relevant.length === 0
          ? false
          : worstStatus(criticalStates(relevant)) !== 'down';
    }
    const message = healthy
      ? describeProblems(relevant)
      : states === null
        ? 'health source failed'
        : relevant.length === 0
          ? `${target.app ?? 'app'} is not reporting`
          : describeProblems(relevant);
    // Building the requests parses the URL (Cronitor, Uptime Kuma): a malformed
    // one is this target's error, never a rejected tick.
    let requests: HeartbeatRequests;
    try {
      requests = heartbeatRequests(config.provider, target.url, message, config.failUrl);
    } catch {
      this.warn(target, new Error('invalid ping URL'));
      return 'error';
    }
    let request: HttpRequest | null;
    let outcome: HeartbeatOutcome;
    if (healthy) {
      request = requests.ok;
      outcome = 'ok';
    } else if ((config.onUnhealthy ?? 'fail') === 'fail' && requests.fail !== null) {
      request = requests.fail;
      outcome = 'fail';
    } else {
      return 'skipped';
    }
    try {
      await deliver(request, { ...this.deps, retries: this.deps.retries ?? 1 });
      this.failing.delete(target.label);
      return outcome;
    } catch (error: unknown) {
      this.warn(target, error);
      return 'error';
    }
  }

  private warn(target: Target, error: unknown): void {
    if (this.failing.has(target.label)) return;
    this.failing.add(target.label);
    this.logger(
      `Telescope heartbeat '${target.label}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Boot-time validation (fails closed, like the rest of `alerts`): a heartbeat
 * needs a `url` or `apps`, every URL must parse, and `every` must be a valid
 * duration. Errors name the heartbeat and field, never the URL (it carries the
 * provider's token).
 */
export function validateHeartbeat(config: HeartbeatConfig): void {
  const label = config.name ?? config.provider;
  const appUrls = Object.entries(config.apps ?? {});
  if (config.url === undefined && appUrls.length === 0) {
    throw new Error(`Telescope heartbeat '${label}' needs a url or apps`);
  }
  if (config.url !== undefined && !URL.canParse(config.url)) {
    throw new Error(`Telescope heartbeat '${label}': invalid url`);
  }
  for (const [app, url] of appUrls) {
    if (typeof url !== 'string' || !URL.canParse(url)) {
      throw new Error(`Telescope heartbeat '${label}': invalid url for app '${app}'`);
    }
  }
  if (config.failUrl !== undefined && !URL.canParse(config.failUrl)) {
    throw new Error(`Telescope heartbeat '${label}': invalid failUrl`);
  }
  durationToMs(config.every ?? '60s');
}
