// packages/core/src/fleet/config.ts
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { durationToMs } from '../config/parse-duration.js';
import { normalizeAppUrl } from '../discovery/config.js';
import { ROLE_RE } from './heartbeat.js';
import type { FleetStore } from './store.js';

/** `fleet` in `TelescopeModule.forRoot()`: this instance's heartbeat, and how the fleet is read. */
export interface FleetConfig {
  /**
   * Send heartbeats and keep the fleet. Default: on for a control plane and a tenant, off for a
   * standalone app (turn it on with `fleet: true` or `fleet: {}`).
   */
  enabled?: boolean;
  /** How often each instance sends a heartbeat. Default `'15s'`. */
  interval?: number | string;
  /**
   * This app's name in the fleet when it keeps its own entries (standalone, control plane). A
   * tenant is named by its token. Default `APP_NAME`, else the package.json `name`, else `'app'`.
   */
  app?: string;
  /**
   * The deployed version: a string, or a function. Default the first of `GIT_SHA`, `COMMIT_SHA`,
   * `SOURCE_VERSION`, `RENDER_GIT_COMMIT`, `RAILWAY_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA`,
   * `HEROKU_SLUG_COMMIT`, `K_REVISION` (a sha is cut to 12 characters), else the package.json `version`.
   */
  version?: string | (() => string | null | Promise<string | null>);
  /** Host or pod name. Default `HOSTNAME`, else the OS hostname. */
  host?: string;
  /** An instance is gone after this many missed heartbeats. Default 3. */
  goneAfter?: number;
  /** How long a gone instance is kept (its deploy and restart history). Default `'7d'`. */
  retention?: number | string;
  /** A restart loop: `restarts` boots on one host `within` a window. Default 3 in `'10m'`. */
  restartLoop?: { restarts?: number; within?: number | string };
  /** Where the control plane (or a standalone app) keeps instances. Default in memory. */
  store?: FleetStore;
  /**
   * The URL other apps reach this one at (`https://billing.internal`), sent with each heartbeat so
   * the control plane can tell other apps where it is (service discovery). Default `APP_URL`;
   * none when unset.
   */
  url?: string;
  /**
   * What this process is in the fleet: `'web'`, or a worker's name (`'billing-consumer'`). Default:
   * detected. A process serving HTTP (`NestFactory.create`) is `web` and reports from boot. A
   * process without an HTTP server (`NestFactory.createApplicationContext`, a microservice) is a
   * worker: it reports once it has run for `workerAfter`, so a short command (a migration, a
   * script) never becomes an instance, named after what marked it (`markFleetWorker('bullmq')`,
   * which the BullMQ watcher calls when the app has processors; `bullmq+durable` for several) or
   * `worker`. Setting `role` reports right away under that name.
   */
  role?: string;
  /**
   * Which kinds of process report a heartbeat. Default `['web', 'worker']`; `['web']` keeps
   * workers out of the fleet.
   */
  report?: Array<'web' | 'worker'>;
  /**
   * How long a process without an HTTP server (and without `role`) runs before it reports as a
   * worker. Default `'30s'`.
   */
  workerAfter?: number | string;
}

/** {@link FleetConfig} with defaults. */
export interface ResolvedFleetConfig {
  enabled: boolean;
  intervalMs: number;
  app: string | null;
  version: FleetConfig['version'] | null;
  host: string;
  goneAfterIntervals: number;
  retentionMs: number;
  restartLoop: { restarts: number; withinMs: number };
  store: FleetStore | null;
  /** This app's URL (`fleet.url`, else `APP_URL`), or `null`. */
  url: string | null;
  /** `fleet.role`, or `null` to detect it. */
  role: string | null;
  report: { web: boolean; worker: boolean };
  workerAfterMs: number;
}

const PREFIX = '[@dudousxd/nestjs-telescope]';

function positiveMs(value: number | string | undefined, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  let parsed: number;
  try {
    parsed = durationToMs(value);
  } catch {
    throw new Error(`${PREFIX} fleet.${key} must be a duration such as '15s' or '10m'`);
  }
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${PREFIX} fleet.${key} must be a positive duration`);
  }
  return parsed;
}

/**
 * `fleet` with defaults. `onByDefault`: whether the topology keeps or reports a fleet when `fleet`
 * is omitted (a control plane and a tenant do; a standalone app does not, so it is unchanged).
 */
export function resolveFleetConfig(
  config: FleetConfig | boolean | undefined,
  onByDefault: boolean,
): ResolvedFleetConfig {
  const fleet: FleetConfig =
    config === false
      ? { enabled: false }
      : config === true
        ? { enabled: true }
        : config === undefined
          ? { enabled: onByDefault }
          : config;
  const store = fleet.store ?? null;
  if (store !== null && (typeof store !== 'object' || typeof store.upsert !== 'function')) {
    throw new Error(`${PREFIX} fleet.store must be a FleetStore`);
  }
  if (fleet.app !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(fleet.app)) {
    throw new Error(`${PREFIX} fleet.app must be 1-64 of A-Z a-z 0-9 _ . -`);
  }
  const intervalMs = positiveMs(fleet.interval, 15_000, 'interval');
  if (intervalMs < 1000) throw new Error(`${PREFIX} fleet.interval must be at least 1s`);
  const goneAfter = fleet.goneAfter ?? 3;
  if (!Number.isInteger(goneAfter) || goneAfter < 1) {
    throw new Error(`${PREFIX} fleet.goneAfter must be a whole number of heartbeats (1 or more)`);
  }
  if (fleet.role !== undefined && !ROLE_RE.test(fleet.role)) {
    throw new Error(`${PREFIX} fleet.role must be 1-64 of A-Z a-z 0-9 _ . : @ / + -`);
  }
  const report = fleet.report ?? ['web', 'worker'];
  if (!Array.isArray(report) || report.some((kind) => kind !== 'web' && kind !== 'worker')) {
    throw new Error(`${PREFIX} fleet.report must list 'web' and/or 'worker'`);
  }
  const restarts = fleet.restartLoop?.restarts ?? 3;
  if (!Number.isInteger(restarts) || restarts < 2) {
    throw new Error(`${PREFIX} fleet.restartLoop.restarts must be 2 or more`);
  }
  return {
    enabled: fleet.enabled ?? true,
    intervalMs,
    app: fleet.app ?? null,
    version: fleet.version ?? null,
    host: fleet.host ?? process.env.HOSTNAME ?? safeHostname(),
    goneAfterIntervals: goneAfter,
    retentionMs: positiveMs(fleet.retention, 7 * 86_400_000, 'retention'),
    restartLoop: {
      restarts,
      withinMs: positiveMs(fleet.restartLoop?.within, 10 * 60_000, 'restartLoop.within'),
    },
    store,
    url: resolveAppUrl(fleet.url),
    role: fleet.role ?? null,
    report: { web: report.includes('web'), worker: report.includes('worker') },
    workerAfterMs: positiveMs(fleet.workerAfter, 30_000, 'workerAfter'),
  };
}

function resolveAppUrl(configured: string | undefined): string | null {
  if (configured !== undefined) {
    const url = normalizeAppUrl(configured);
    if (url === null) throw new Error(`${PREFIX} fleet.url must be an absolute http(s) URL`);
    return url;
  }
  // APP_URL is a convention, not a promise: a malformed one is ignored rather than fatal.
  return normalizeAppUrl(process.env.APP_URL);
}

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return 'unknown';
  }
}

/** Environment variables hosts set to the deployed commit, checked in order. */
export const VERSION_ENV_VARS = [
  'GIT_SHA',
  'COMMIT_SHA',
  'SOURCE_VERSION',
  'RENDER_GIT_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'HEROKU_SLUG_COMMIT',
  'K_REVISION',
] as const;

/** The app's package.json (in `appRoot`, default the working directory), or `{}`. */
async function readPackageJson(appRoot: string = process.cwd()): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/** The version an instance reports (see {@link FleetConfig.version}). */
export async function resolveVersion(
  configured: FleetConfig['version'] | null,
  appRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (typeof configured === 'string') return configured.slice(0, 100);
  if (typeof configured === 'function') {
    try {
      const value = await configured();
      return typeof value === 'string' && value !== '' ? value.slice(0, 100) : null;
    } catch {
      return null;
    }
  }
  for (const name of VERSION_ENV_VARS) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      const trimmed = value.trim();
      return /^[0-9a-f]{13,40}$/i.test(trimmed) ? trimmed.slice(0, 12) : trimmed.slice(0, 100);
    }
  }
  const version = (await readPackageJson(appRoot)).version;
  return typeof version === 'string' ? version : null;
}

/** The app name a standalone app or a control plane reports for itself. */
export async function resolveSelfApp(
  configured: string | null,
  appRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (configured !== null) return configured;
  const fromEnv = env.APP_NAME;
  const clean = (value: string) =>
    value
      .replace(/^@[^/]+\//, '')
      .replace(/[^A-Za-z0-9_.-]/g, '-')
      .slice(0, 64);
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return clean(fromEnv.trim()) || 'app';
  const name = (await readPackageJson(appRoot)).name;
  return typeof name === 'string' && name !== '' ? clean(name) || 'app' : 'app';
}
