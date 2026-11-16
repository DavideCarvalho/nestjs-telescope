// packages/core/src/fleet/checks.ts
//
// Health checks: what this process depends on (Redis, the database, a payment API), each cached
// and single-flight, reported in the heartbeat, on the Fleet page and by the readiness probe.
import { randomUUID } from 'node:crypto';
import { durationToMs } from '../config/parse-duration.js';
import { runAsTelescopeWork } from '../otel/telescope-runtime.js';

/** A check's state: `ok`, `warn` (degraded, still serving) or `down`. `unknown` before the first run. */
export type CheckStatus = 'ok' | 'warn' | 'down' | 'unknown';

/** What one run of a check returns. */
export interface CheckOutcome {
  status: 'ok' | 'warn' | 'down';
  /** One line for the console and the alert. */
  message?: string;
  /** Extra numbers to show (memory used, latency…). Kept small. */
  meta?: Record<string, string | number | boolean | null>;
}

/** A telescope health check: `checks.redis()`, `checks.terminus()`, `checks.custom()`. */
export interface TelescopeCheck {
  readonly name: string;
  /** How long a result is reused. Default `30s`. */
  readonly cacheFor?: number | string;
  /** A run taking longer is `down`. Default `5s`. */
  readonly timeout?: number | string;
  /**
   * Whether a `down` makes the instance not ready (the readiness probe answers 503). Default
   * `true`; a `false` check is shown and alerted on but never takes the instance out of rotation.
   */
  readonly critical?: boolean;
  run(): Promise<CheckOutcome>;
}

/** The last known result of a check, as the console, the heartbeat and the alerts see it. */
export interface CheckState {
  name: string;
  status: CheckStatus;
  message: string | null;
  /** Epoch ms since the check has been in this status (a `down` since 12 minutes ago). */
  since: number;
  /** Epoch ms of the run this state comes from (0 before the first run). */
  checkedAt: number;
  durationMs: number | null;
  critical: boolean;
  meta?: Record<string, string | number | boolean | null>;
}

const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MESSAGE = 300;

function ms(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  try {
    const parsed = durationToMs(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function oneLine(text: unknown): string {
  const value = text instanceof Error ? text.message : String(text);
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
}

function isFlatMeta(value: unknown): value is Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(
    (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function normalizeOutcome(result: unknown): CheckOutcome {
  const r = (result ?? {}) as { status?: unknown; message?: unknown; meta?: unknown };
  const status =
    r.status === 'ok' ? 'ok' : r.status === 'warn' || r.status === 'warning' ? 'warn' : 'down';
  return {
    status,
    ...(typeof r.message === 'string' && r.message !== '' ? { message: r.message } : {}),
    ...(isFlatMeta(r.meta) ? { meta: r.meta } : {}),
  };
}

interface Slot {
  check: TelescopeCheck;
  cacheMs: number;
  timeoutMs: number;
  critical: boolean;
  state: CheckState;
  inflight: Promise<CheckState> | null;
}

/** The overall answer of a set of checks. */
export interface HealthReport {
  /** `down` when a critical check is down, `warn` when any check is not ok, else `ok`. */
  status: 'ok' | 'warn' | 'down';
  checks: CheckState[];
}

/**
 * The configured checks of this process. Each result is reused for its `cacheFor` (default 30 s)
 * and concurrent callers share one run (single-flight), so a kubelet probing every second and the
 * heartbeat every 15 s cost one `PING` per 30 s.
 */
export class HealthChecks {
  private readonly slots: Slot[];
  private readonly now: () => number;

  constructor(inputs: readonly TelescopeCheck[], options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    const names = new Set<string>();
    this.slots = inputs.map((check) => {
      if (
        check === null ||
        typeof check !== 'object' ||
        typeof check.name !== 'string' ||
        check.name === '' ||
        typeof check.run !== 'function'
      ) {
        throw new Error(
          '[@dudousxd/nestjs-telescope] every entry of `checks` must be checks.redis(), checks.terminus() or checks.custom().',
        );
      }
      if (names.has(check.name)) {
        throw new Error(`[@dudousxd/nestjs-telescope] two checks are named "${check.name}".`);
      }
      names.add(check.name);
      const critical = check.critical !== false;
      return {
        check,
        cacheMs: ms(check.cacheFor, DEFAULT_CACHE_MS),
        timeoutMs: ms(check.timeout, DEFAULT_TIMEOUT_MS),
        critical,
        state: {
          name: check.name,
          status: 'unknown',
          message: null,
          since: this.now(),
          checkedAt: 0,
          durationMs: null,
          critical,
        },
        inflight: null,
      };
    });
  }

  /** How many checks are configured. */
  get size(): number {
    return this.slots.length;
  }

  /** The last known states, without running anything. */
  states(): CheckState[] {
    return this.slots.map((slot) => ({ ...slot.state }));
  }

  /** Runs every check whose cached result is stale (sharing a run already in flight). */
  run(): Promise<CheckState[]> {
    return Promise.all(this.slots.map((slot) => this.runSlot(slot)));
  }

  /** Runs (as needed) and summarizes. */
  async report(): Promise<HealthReport> {
    return summarizeChecks(await this.run());
  }

  private runSlot(slot: Slot): Promise<CheckState> {
    if (slot.state.checkedAt !== 0 && this.now() - slot.state.checkedAt < slot.cacheMs) {
      return Promise.resolve({ ...slot.state });
    }
    if (slot.inflight !== null) return slot.inflight;
    const run = this.execute(slot).finally(() => {
      slot.inflight = null;
    });
    slot.inflight = run;
    return run;
  }

  private async execute(slot: Slot): Promise<CheckState> {
    const started = this.now();
    let outcome: CheckOutcome;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Telescope's own work: the check's Redis or SQL calls are not recorded as the app's.
      outcome = await runAsTelescopeWork(() =>
        Promise.race([
          Promise.resolve()
            .then(() => slot.check.run())
            .then(normalizeOutcome),
          new Promise<CheckOutcome>((resolve) => {
            timer = setTimeout(
              () => resolve({ status: 'down', message: `timed out after ${slot.timeoutMs} ms` }),
              slot.timeoutMs,
            );
            timer.unref?.();
          }),
        ]),
      );
    } catch (error) {
      outcome = { status: 'down', message: oneLine(error) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const finished = this.now();
    const previous = slot.state;
    slot.state = {
      name: slot.check.name,
      status: outcome.status,
      message: outcome.message !== undefined ? oneLine(outcome.message) : null,
      since: previous.status === outcome.status ? previous.since : finished,
      checkedAt: finished,
      durationMs: Math.max(0, finished - started),
      critical: slot.critical,
      ...(outcome.meta !== undefined ? { meta: outcome.meta } : {}),
    };
    return { ...slot.state };
  }
}

/** The overall status of some check states. */
export function summarizeChecks(states: CheckState[]): HealthReport {
  let status: HealthReport['status'] = 'ok';
  for (const state of states) {
    if (state.status === 'down' && state.critical) return { status: 'down', checks: states };
    if (state.status !== 'ok') status = 'warn';
  }
  return { status, checks: states };
}

/** Options shared by the built-in checks. */
export interface CheckOptions {
  /** The name shown in the console and in alerts. */
  name?: string;
  /** How long a result is reused. Default `30s`. */
  cacheFor?: number | string;
  /** A run taking longer is `down`. Default `5s`. */
  timeout?: number | string;
  /** Whether a `down` takes the instance out of rotation (readiness 503). Default `true`. */
  critical?: boolean;
}

/** The commands `checks.redis()` sends: an ioredis client fits. */
export interface RedisCheckClient {
  ping(): Promise<unknown>;
  set?(...args: (string | number)[]): Promise<unknown>;
  info?(section?: string): Promise<string>;
}

/** Options of `checks.redis()`. */
export interface RedisCheckOptions extends CheckOptions {
  /** The client to check (an ioredis instance), or a function returning it. */
  client: object | (() => object);
  /**
   * Also write a short-lived key, so a Redis that answers `PING` but refuses writes
   * (`maxmemory` reached with `noeviction`: "OOM command not allowed") is `down`. Default `true`.
   */
  write?: boolean;
  /** `used_memory / maxmemory` at or above which the check is `warn`. Default `0.9`. */
  memoryWarnRatio?: number;
}

function base(name: string, options: CheckOptions) {
  return {
    name: options.name ?? name,
    ...(options.cacheFor !== undefined ? { cacheFor: options.cacheFor } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.critical !== undefined ? { critical: options.critical } : {}),
  };
}

/** Parses `used_memory` / `maxmemory` out of `INFO memory`. */
export function redisMemory(info: string): { used: number; max: number } | null {
  const used = /^used_memory:(\d+)/m.exec(info)?.[1];
  const max = /^maxmemory:(\d+)/m.exec(info)?.[1];
  if (used === undefined || max === undefined) return null;
  return { used: Number(used), max: Number(max) };
}

/**
 * Health checks for `checks` in `TelescopeModule.forRoot()`:
 *
 * ```ts
 * checks: [
 *   checks.redis({ client: redis }),
 *   checks.terminus('db', () => db.pingCheck('db')),
 *   checks.custom('stripe', async () => ({ status: 'ok' })),
 * ],
 * ```
 */
export const checks = {
  /** `PING`, a short-lived write and `INFO memory` on an ioredis client. */
  redis(options: RedisCheckOptions): TelescopeCheck {
    const write = options.write !== false;
    const warnRatio = options.memoryWarnRatio ?? 0.9;
    return {
      ...base('redis', options),
      async run() {
        const client = (
          typeof options.client === 'function' ? (options.client as () => object)() : options.client
        ) as RedisCheckClient;
        await client.ping();
        if (write && typeof client.set === 'function') {
          // A Redis at maxmemory with `noeviction` still answers PING; a write is what fails.
          await client.set(`telescope:health:${randomUUID()}`, '1', 'PX', 10_000);
        }
        if (typeof client.info === 'function') {
          const memory = redisMemory(await client.info('memory'));
          if (memory !== null && memory.max > 0) {
            const ratio = memory.used / memory.max;
            const meta = { usedMemory: memory.used, maxMemory: memory.max };
            if (ratio >= warnRatio) {
              return {
                status: 'warn',
                message: `memory at ${Math.round(ratio * 100)}% of maxmemory`,
                meta,
              };
            }
            return { status: 'ok', meta };
          }
        }
        return { status: 'ok' };
      },
    };
  },

  /**
   * An `@nestjs/terminus` health indicator call (`() => db.pingCheck('db')`): every indicator in
   * its result `up` is `ok`; one `down`, or a throw (`HealthCheckError`), is `down`.
   */
  terminus(
    name: string,
    indicator: () => Promise<Record<string, { status?: string; message?: unknown }>>,
    options: Omit<CheckOptions, 'name'> = {},
  ): TelescopeCheck {
    return {
      ...base(name, options),
      async run() {
        const result = await indicator();
        const down = Object.entries(result ?? {}).find(([, value]) => value?.status !== 'up');
        if (down === undefined) return { status: 'ok' };
        const message = down[1]?.message;
        return {
          status: 'down',
          message:
            typeof message === 'string' ? message : `${down[0]} is ${down[1]?.status ?? 'down'}`,
        };
      },
    };
  },

  /**
   * A check of your own: `run` answers `{ status: 'ok' | 'warn' | 'down', message? }`, or throws
   * (a throw is `down` with the error's message).
   */
  custom(
    name: string,
    run: () => Promise<CheckOutcome> | CheckOutcome,
    options: Omit<CheckOptions, 'name'> = {},
  ): TelescopeCheck {
    if (typeof name !== 'string' || name === '') {
      throw new Error('[@dudousxd/nestjs-telescope] checks.custom() needs a name.');
    }
    return { ...base(name, options), run: async () => run() };
  },
};
