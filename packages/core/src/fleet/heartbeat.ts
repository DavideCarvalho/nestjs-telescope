// packages/core/src/fleet/heartbeat.ts
//
// What an instance says about itself every interval. A tenant's heartbeat rides its batches.
import { normalizeAppUrl } from '../discovery/config.js';
import type { CheckState, CheckStatus } from './checks.js';

/** The lifecycle state an instance reports: booting, serving, or shutting down. */
export type InstanceState = 'starting' | 'ready' | 'draining';

/** How the instance's entries are getting out (a tenant's buffer), when it ships them. */
export interface HeartbeatShipping {
  /** Entries waiting to be sent. */
  buffered: number;
  /** Entries dropped since boot (buffer full, or unserializable). */
  dropped: number;
  /** Entries sent since boot. */
  sent: number;
  /** Consecutive failed sends. */
  failures: number;
  /** How far behind the buffer is (ms since the last successful send while entries wait), else 0. */
  lagMs: number;
  /** The last send error, one line. */
  lastError: string | null;
}

/** One heartbeat, as an instance sends it (`heartbeat` next to `entries` in an ingest batch). */
export interface InstanceHeartbeat {
  v: 1;
  /** Unique per process (a new one on every boot). */
  instanceId: string;
  /** Host or pod name. */
  host: string;
  pid: number;
  /** The deployed version (a git sha, the package.json version), or `null`. */
  version: string | null;
  /** When the process booted (ISO 8601). */
  bootedAt: string;
  /** When this heartbeat was built (ISO 8601). */
  sentAt: string;
  state: InstanceState;
  /** The instance's heartbeat interval: it is gone after a few missed ones. */
  intervalMs: number;
  checks: CheckState[];
  shipping: HeartbeatShipping | null;
  /** The URL other apps reach this one at (`fleet.url`), or `null`. Absent from older senders. */
  url?: string | null;
  /**
   * What the process is: `web` (the HTTP server) or a worker's name (`bullmq`, `durable`, a
   * `fleet.role`). Absent from older senders, which are web.
   */
  role?: string;
  /**
   * The watchers this process runs (`query`, `job`, …), so a control plane can tell "this app does
   * not record queries" from "no slow query". Absent from older senders: unknown.
   */
  watchers?: string[];
}

/** The role of the HTTP server, and of every instance that says none. */
export const WEB_ROLE = 'web';

/** A role: 1-64 of `A-Z a-z 0-9 _ . : @ / + -`. */
export const ROLE_RE = /^[A-Za-z0-9_.:@/+-]{1,64}$/;

/** A sender's role, or `web` when it says none (an older sender) or an invalid one. */
export function normalizeRole(value: unknown): string {
  return typeof value === 'string' && ROLE_RE.test(value) ? value : WEB_ROLE;
}

const STATES: readonly InstanceState[] = ['starting', 'ready', 'draining'];
const CHECK_STATUSES: readonly CheckStatus[] = ['ok', 'warn', 'down', 'unknown'];
const ID_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_CHECKS = 50;
const MAX_WATCHERS = 64;
const WATCHER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A watcher list as a heartbeat may carry it (deduped, sorted, bounded), else `undefined`. */
export function normalizeWatchers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const name of value) {
    if (names.size >= MAX_WATCHERS) break;
    if (typeof name === 'string' && WATCHER_RE.test(name)) names.add(name);
  }
  return [...names].sort();
}

const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
const int = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
const time = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

function normalizeCheck(raw: unknown): CheckState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const name = str(c.name, 100);
  if (name === null || !CHECK_STATUSES.includes(c.status as CheckStatus)) return null;
  const meta: Record<string, string | number | boolean | null> = {};
  if (c.meta !== null && typeof c.meta === 'object' && !Array.isArray(c.meta)) {
    for (const [key, value] of Object.entries(c.meta).slice(0, 10)) {
      if (
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'string'
      ) {
        meta[key.slice(0, 64)] = typeof value === 'string' ? value.slice(0, 200) : value;
      }
    }
  }
  return {
    name,
    status: c.status as CheckStatus,
    message: str(c.message, 300),
    since: int(c.since),
    checkedAt: int(c.checkedAt),
    durationMs: typeof c.durationMs === 'number' ? int(c.durationMs) : null,
    critical: c.critical !== false,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

/**
 * Validate a heartbeat a sender put in its batch. `null` when it is not one. Strings and lists
 * are bounded, so a sender cannot grow the server's instance table without limit.
 */
export function normalizeHeartbeat(raw: unknown): InstanceHeartbeat | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (h.v !== 1) return null;
  if (typeof h.instanceId !== 'string' || !ID_RE.test(h.instanceId)) return null;
  if (!STATES.includes(h.state as InstanceState)) return null;
  const bootedAt = time(h.bootedAt);
  const sentAt = time(h.sentAt);
  if (bootedAt === null || sentAt === null) return null;
  const checks = Array.isArray(h.checks)
    ? h.checks
        .slice(0, MAX_CHECKS)
        .map(normalizeCheck)
        .filter((c): c is CheckState => c !== null)
    : [];
  let shipping: HeartbeatShipping | null = null;
  if (h.shipping !== null && typeof h.shipping === 'object') {
    const s = h.shipping as Record<string, unknown>;
    shipping = {
      buffered: int(s.buffered),
      dropped: int(s.dropped),
      sent: int(s.sent),
      failures: int(s.failures),
      lagMs: int(s.lagMs),
      lastError: str(s.lastError, 300),
    };
  }
  const watchers = normalizeWatchers(h.watchers);
  return {
    v: 1,
    instanceId: h.instanceId,
    host: str(h.host, 255) ?? 'unknown',
    pid: int(h.pid),
    version: str(h.version, 100),
    bootedAt: new Date(bootedAt).toISOString(),
    sentAt: new Date(sentAt).toISOString(),
    state: h.state as InstanceState,
    // Between 1 s and 1 h: a bogus interval must not make an instance look alive forever.
    intervalMs: Math.min(3_600_000, Math.max(1000, int(h.intervalMs, 15_000))),
    checks,
    shipping,
    url: normalizeAppUrl(h.url),
    role: normalizeRole(h.role),
    ...(watchers !== undefined ? { watchers } : {}),
  };
}
