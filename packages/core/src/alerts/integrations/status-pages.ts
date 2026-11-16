// packages/core/src/alerts/integrations/status-pages.ts
import { durationToMs } from '../../config/parse-duration.js';
import {
  type CheckStateSource,
  type HealthStatus,
  type UptimeCheckState,
  describeProblems,
  healthOf,
  readStates,
  worse,
  worstStatus,
} from './check-states.js';
import { type HttpDeps, type HttpRequest, deliver } from './http.js';

/**
 * Status page sync: Telescope keeps each mapped status page component in step
 * with the check (or app) it's mapped to, and can open an incident while
 * anything is down and resolve it once everything is back.
 *
 * Mapping keys (`components`):
 *  - `'redis'`              — the check named `redis` (worst across apps);
 *  - `'app:checkout'`       — every check of app `checkout`;
 *  - `'checkout/redis'`     — the `redis` check of app `checkout`;
 *  - `'*'`                  — every check.
 * A key with no matching states is left alone (Telescope doesn't guess).
 */

interface StatusPageBase {
  /** Mapping key → provider component id (see the module docs for keys). */
  components: Record<string, string>;
  /** Also open an incident while a component is not up, and resolve it after. Default `false`. */
  incidents?: boolean;
  /** Incident title. Default `'Service disruption'`. */
  incidentName?: string;
  /** Sync cadence. Default `'60s'`. */
  every?: string;
  /** Name in failure logs. Default: the provider. */
  name?: string;
}

/** Atlassian Statuspage. */
export interface AtlassianStatuspageConfig extends StatusPageBase {
  provider: 'statuspage';
  /** API key (sent as `Authorization: OAuth …`). */
  apiKey: string;
  pageId: string;
  /** Default `https://api.statuspage.io`. */
  baseUrl?: string;
}

/** Instatus. */
export interface InstatusConfig extends StatusPageBase {
  provider: 'instatus';
  /** API key (Bearer). */
  apiKey: string;
  pageId: string;
  /** Default `https://api.instatus.com`. */
  baseUrl?: string;
}

/**
 * Better Stack status pages. Better Stack derives a resource's status from its
 * monitors or from status reports, so Telescope publishes a status report
 * naming the affected resources (component ids are status-page resource ids)
 * and resolves it when they recover. `incidents` is always on here.
 */
export interface BetterStackStatusPageConfig extends StatusPageBase {
  provider: 'betterstack';
  /** Better Stack Uptime API token. */
  apiToken: string;
  statusPageId: string;
  /** Default `https://incidents.betterstack.com`. */
  baseUrl?: string;
}

export type StatusPageConfig =
  | AtlassianStatuspageConfig
  | InstatusConfig
  | BetterStackStatusPageConfig;

/** Resolve a mapping key against the states. `null` = no matching state. */
export function statusForKey(
  states: readonly UptimeCheckState[],
  key: string,
): HealthStatus | null {
  let matching: UptimeCheckState[];
  if (key === '*') matching = [...states];
  else if (key.startsWith('app:')) {
    const app = key.slice(4);
    matching = states.filter((state) => state.app === app);
  } else if (key.includes('/')) {
    const slash = key.indexOf('/');
    const app = key.slice(0, slash);
    const name = key.slice(slash + 1);
    matching = states.filter((state) => state.app === app && state.name === name);
  } else {
    matching = states.filter((state) => state.name === key);
  }
  // Checks that haven't run yet (`unknown`) don't move a component.
  const known = matching.filter((state) => healthOf(state) !== null);
  return known.length === 0 ? null : worstStatus(known);
}

/** The states a mapping key covers (for incident messages). */
function statesForKey(states: readonly UptimeCheckState[], key: string): UptimeCheckState[] {
  if (key === '*') return [...states];
  if (key.startsWith('app:')) return states.filter((state) => state.app === key.slice(4));
  if (key.includes('/')) {
    const [app, name] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    return states.filter((state) => state.app === app && state.name === name);
  }
  return states.filter((state) => state.name === key);
}

/** Component id → status, the worst when several keys map to one component. */
export function componentStatuses(
  states: readonly UptimeCheckState[],
  components: Record<string, string>,
): Map<string, HealthStatus> {
  const result = new Map<string, HealthStatus>();
  for (const [key, componentId] of Object.entries(components)) {
    const status = statusForKey(states, key);
    if (status === null) continue;
    const previous = result.get(componentId);
    result.set(componentId, previous === undefined ? status : worse(previous, status));
  }
  return result;
}

const STATUSPAGE_STATUS: Record<HealthStatus, string> = {
  up: 'operational',
  degraded: 'degraded_performance',
  down: 'major_outage',
};
const INSTATUS_STATUS: Record<HealthStatus, string> = {
  up: 'OPERATIONAL',
  degraded: 'DEGRADEDPERFORMANCE',
  down: 'MAJOROUTAGE',
};
const BETTERSTACK_STATUS: Record<HealthStatus, string> = {
  up: 'resolved',
  degraded: 'degraded',
  down: 'downtime',
};

/** Provider calls, as pure request builders (tests assert on them). */
export const statusPageRequests = {
  statuspage: {
    component(config: AtlassianStatuspageConfig, id: string, status: HealthStatus): HttpRequest {
      return {
        method: 'PATCH',
        url: `${base(config.baseUrl, 'https://api.statuspage.io')}/v1/pages/${enc(config.pageId)}/components/${enc(id)}`,
        headers: { authorization: `OAuth ${config.apiKey}` },
        body: { component: { status: STATUSPAGE_STATUS[status] } },
      };
    },
    openIncident(
      config: AtlassianStatuspageConfig,
      statuses: Map<string, HealthStatus>,
      message: string,
    ): HttpRequest {
      return {
        method: 'POST',
        url: `${base(config.baseUrl, 'https://api.statuspage.io')}/v1/pages/${enc(config.pageId)}/incidents`,
        headers: { authorization: `OAuth ${config.apiKey}` },
        body: {
          incident: {
            name: config.incidentName ?? 'Service disruption',
            status: 'investigating',
            body: message,
            component_ids: [...statuses.keys()],
            components: Object.fromEntries(
              [...statuses].map(([id, status]) => [id, STATUSPAGE_STATUS[status]]),
            ),
          },
        },
      };
    },
    resolveIncident(
      config: AtlassianStatuspageConfig,
      incidentId: string,
      componentIds: string[],
    ): HttpRequest {
      return {
        method: 'PATCH',
        url: `${base(config.baseUrl, 'https://api.statuspage.io')}/v1/pages/${enc(config.pageId)}/incidents/${enc(incidentId)}`,
        headers: { authorization: `OAuth ${config.apiKey}` },
        body: {
          incident: {
            status: 'resolved',
            body: 'All systems operational.',
            components: Object.fromEntries(componentIds.map((id) => [id, 'operational'])),
          },
        },
      };
    },
  },
  instatus: {
    component(config: InstatusConfig, id: string, status: HealthStatus): HttpRequest {
      return {
        method: 'PUT',
        // Component updates are on Instatus API v2; incidents stay on v1.
        url: `${base(config.baseUrl, 'https://api.instatus.com')}/v2/${enc(config.pageId)}/components/${enc(id)}`,
        headers: { authorization: `Bearer ${config.apiKey}` },
        body: { status: INSTATUS_STATUS[status] },
      };
    },
    openIncident(
      config: InstatusConfig,
      statuses: Map<string, HealthStatus>,
      message: string,
      startedAt: string,
    ): HttpRequest {
      return {
        method: 'POST',
        url: `${base(config.baseUrl, 'https://api.instatus.com')}/v1/${enc(config.pageId)}/incidents`,
        headers: { authorization: `Bearer ${config.apiKey}` },
        body: {
          name: config.incidentName ?? 'Service disruption',
          message,
          components: [...statuses.keys()],
          started: startedAt,
          status: 'INVESTIGATING',
          notify: true,
          statuses: [...statuses].map(([id, status]) => ({ id, status: INSTATUS_STATUS[status] })),
        },
      };
    },
    resolveIncident(
      config: InstatusConfig,
      incidentId: string,
      componentIds: string[],
      startedAt: string,
    ): HttpRequest {
      return {
        method: 'POST',
        url: `${base(config.baseUrl, 'https://api.instatus.com')}/v1/${enc(config.pageId)}/incidents/${enc(incidentId)}/incident-updates`,
        headers: { authorization: `Bearer ${config.apiKey}` },
        body: {
          message: 'All systems operational.',
          components: componentIds,
          started: startedAt,
          status: 'RESOLVED',
          notify: true,
          statuses: componentIds.map((id) => ({ id, status: 'OPERATIONAL' })),
        },
      };
    },
  },
  betterstack: {
    openReport(
      config: BetterStackStatusPageConfig,
      statuses: Map<string, HealthStatus>,
      message: string,
    ): HttpRequest {
      return {
        method: 'POST',
        url: `${base(config.baseUrl, 'https://incidents.betterstack.com')}/api/v2/status-pages/${enc(config.statusPageId)}/status-reports`,
        headers: { authorization: `Bearer ${config.apiToken}` },
        body: {
          title: config.incidentName ?? 'Service disruption',
          message,
          report_type: 'manual',
          affected_resources: [...statuses].map(([id, status]) => ({
            status_page_resource_id: id,
            status: BETTERSTACK_STATUS[status],
          })),
        },
      };
    },
    updateReport(
      config: BetterStackStatusPageConfig,
      reportId: string,
      statuses: Map<string, HealthStatus>,
      message: string,
    ): HttpRequest {
      return {
        method: 'POST',
        url: `${base(config.baseUrl, 'https://incidents.betterstack.com')}/api/v2/status-pages/${enc(config.statusPageId)}/status-reports/${enc(reportId)}/status-updates`,
        headers: { authorization: `Bearer ${config.apiToken}` },
        body: {
          message,
          affected_resources: [...statuses].map(([id, status]) => ({
            status_page_resource_id: id,
            status: BETTERSTACK_STATUS[status],
          })),
        },
      };
    },
  },
};

function base(url: string | undefined, fallback: string): string {
  return (url ?? fallback).replace(/\/+$/, '');
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function readId(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const direct = (json as { id?: unknown }).id;
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
  const nested = (json as { data?: { id?: unknown } }).data?.id;
  return typeof nested === 'string' || typeof nested === 'number' ? String(nested) : null;
}

export interface StatusPageSyncDeps extends HttpDeps {
  statusPages: StatusPageConfig[];
  source: CheckStateSource;
  logger?: (message: string) => void;
  now?: () => number;
}

interface PageState {
  config: StatusPageConfig;
  label: string;
  everyMs: number;
  lastAt: number;
  /** Last status successfully sent per component id. */
  sent: Map<string, HealthStatus>;
  incidentId: string | null;
  incidentStartedAt: string | null;
  /** Component statuses last reported on the open incident. */
  incidentStatuses: Map<string, HealthStatus>;
}

/**
 * Keeps status pages in step with the check states. Only CHANGES are sent (a
 * component whose status didn't move costs nothing), and a failed update is
 * retried on the next tick. Never throws.
 */
export class StatusPageSync {
  private readonly pages: PageState[];
  private readonly logger: (message: string) => void;
  private readonly now: () => number;
  private readonly failing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: StatusPageSyncDeps) {
    this.logger = deps.logger ?? ((message) => console.warn(message));
    this.now = deps.now ?? Date.now;
    this.pages = deps.statusPages.map((config) => ({
      config,
      label: config.name ?? config.provider,
      everyMs: durationToMs(config.every ?? '60s'),
      lastAt: Number.NEGATIVE_INFINITY,
      sent: new Map(),
      incidentId: null,
      incidentStartedAt: null,
      incidentStatuses: new Map(),
    }));
  }

  start(): void {
    if (this.timer !== null || this.pages.length === 0) return;
    const run = () => {
      this.tick().catch((error: unknown) =>
        this.logger(`Telescope status page sync failed: ${String(error)}`),
      );
    };
    run();
    const period = this.pages.reduce((min, page) => Math.min(min, page.everyMs), 60_000);
    this.timer = setInterval(run, Math.min(period, 15_000));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sync every page that is due. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = this.now();
      const due = this.pages.filter((page) => nowMs - page.lastAt >= page.everyMs);
      if (due.length === 0) return;
      const states = await readStates(this.deps.source, this.logger);
      if (states === null) return; // unknown health: leave the pages as they are
      for (const page of due) {
        try {
          await this.syncPage(page, states, nowMs);
          // Stamped only on success: a failed sync is retried on the next timer
          // tick (at most 15s later), not a full `every` later.
          page.lastAt = nowMs;
          this.failing.delete(page.label);
        } catch (error: unknown) {
          if (!this.failing.has(page.label)) {
            this.failing.add(page.label);
            this.logger(
              `Telescope status page '${page.label}' sync failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private send(request: HttpRequest) {
    return deliver(request, { ...this.deps, retries: this.deps.retries ?? 1 });
  }

  private async syncPage(
    page: PageState,
    states: UptimeCheckState[],
    nowMs: number,
  ): Promise<void> {
    const statuses = componentStatuses(states, page.config.components);
    const config = page.config;
    const problems = describeProblems(
      Object.keys(config.components).flatMap((key) => statesForKey(states, key)),
    );
    const message = problems === '' ? 'Investigating.' : `Affected: ${problems}`;
    const unhealthy = new Map([...statuses].filter(([, status]) => status !== 'up'));

    if (config.provider === 'betterstack') {
      await this.syncBetterStack(page, config, statuses, unhealthy, message);
      return;
    }

    // Component statuses: only send changes.
    for (const [id, status] of statuses) {
      if (page.sent.get(id) === status) continue;
      const request =
        config.provider === 'statuspage'
          ? statusPageRequests.statuspage.component(config, id, status)
          : statusPageRequests.instatus.component(config, id, status);
      await this.send(request);
      page.sent.set(id, status);
    }

    if (config.incidents !== true) return;
    if (unhealthy.size > 0 && page.incidentId === null) {
      const startedAt = new Date(nowMs).toISOString();
      const result = await this.send(
        config.provider === 'statuspage'
          ? statusPageRequests.statuspage.openIncident(config, unhealthy, message)
          : statusPageRequests.instatus.openIncident(config, unhealthy, message, startedAt),
      );
      // No id in the answer: remember the incident as open (no duplicate), but it
      // can't be resolved by id — that one is closed by hand.
      page.incidentId = readId(result.json) ?? '';
      page.incidentStartedAt = startedAt;
      page.incidentStatuses = new Map(unhealthy);
    } else if (unhealthy.size === 0 && page.incidentId === '') {
      page.incidentId = null;
      page.incidentStartedAt = null;
      page.incidentStatuses = new Map();
    } else if (unhealthy.size === 0 && page.incidentId !== null) {
      const ids = [...page.incidentStatuses.keys()];
      await this.send(
        config.provider === 'statuspage'
          ? statusPageRequests.statuspage.resolveIncident(config, page.incidentId, ids)
          : statusPageRequests.instatus.resolveIncident(
              config,
              page.incidentId,
              ids,
              page.incidentStartedAt ?? new Date(nowMs).toISOString(),
            ),
      );
      page.incidentId = null;
      page.incidentStartedAt = null;
      page.incidentStatuses = new Map();
    }
  }

  private async syncBetterStack(
    page: PageState,
    config: BetterStackStatusPageConfig,
    statuses: Map<string, HealthStatus>,
    unhealthy: Map<string, HealthStatus>,
    message: string,
  ): Promise<void> {
    if (page.incidentId === null) {
      if (unhealthy.size === 0) return;
      const result = await this.send(
        statusPageRequests.betterstack.openReport(config, unhealthy, message),
      );
      // No id in the answer: remember the incident as open (no duplicate), but it
      // can't be resolved by id — that one is closed by hand.
      page.incidentId = readId(result.json) ?? '';
      page.incidentStatuses = new Map(unhealthy);
      return;
    }
    // A report is open: post an update when any affected resource moved.
    const affected = new Map(page.incidentStatuses);
    for (const [id, status] of statuses) {
      if (status !== 'up' || affected.has(id)) affected.set(id, status);
    }
    const changed = [...affected].some(([id, status]) => page.incidentStatuses.get(id) !== status);
    if (!changed) return;
    const resolved = unhealthy.size === 0;
    if (page.incidentId === '') {
      if (resolved) page.incidentId = null;
      page.incidentStatuses = resolved ? new Map() : affected;
      return;
    }
    await this.send(
      statusPageRequests.betterstack.updateReport(
        config,
        page.incidentId,
        affected,
        resolved ? 'All systems operational.' : message,
      ),
    );
    if (resolved) {
      page.incidentId = null;
      page.incidentStatuses = new Map();
    } else {
      page.incidentStatuses = affected;
    }
  }
}

const REQUIRED_STATUS_PAGE_FIELDS: Record<StatusPageConfig['provider'], string[]> = {
  statuspage: ['apiKey', 'pageId'],
  instatus: ['apiKey', 'pageId'],
  betterstack: ['apiToken', 'statusPageId'],
};

/**
 * Boot-time validation of a status page entry (fails closed): a known
 * provider, its key and page id, at least one component, a valid `every`.
 * Errors name the field, never its value.
 */
export function validateStatusPage(config: StatusPageConfig): void {
  const label = config.name ?? config.provider;
  const required = REQUIRED_STATUS_PAGE_FIELDS[config.provider];
  if (required === undefined) {
    throw new Error(`Telescope status page '${label}': unknown provider`);
  }
  const record: Record<string, unknown> = { ...config };
  const missing = required.filter(
    (field) => typeof record[field] !== 'string' || (record[field] as string).trim() === '',
  );
  if (missing.length > 0) {
    throw new Error(`Telescope status page '${label}': missing ${missing.join(', ')}`);
  }
  if (Object.keys(config.components ?? {}).length === 0) {
    throw new Error(`Telescope status page '${label}' maps no components`);
  }
  durationToMs(config.every ?? '60s');
}
