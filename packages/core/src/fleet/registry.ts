// packages/core/src/fleet/registry.ts
import { randomUUID } from 'node:crypto';
import type { HealthChecks } from './checks.js';
import {
  DEFAULT_DERIVE,
  type FleetApp,
  type FleetDeriveOptions,
  type InstanceRecord,
  deriveFleet,
} from './derive.js';
import type { HeartbeatShipping, InstanceHeartbeat, InstanceState } from './heartbeat.js';
import type { FleetStore } from './store.js';

/** Options of {@link FleetRegistry}. */
export interface FleetRegistryOptions {
  derive?: FleetDeriveOptions;
  /** How long a gone instance is kept. Default 7 days. */
  retentionMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Called when a heartbeat cannot be stored (the store is down). */
  onError?: (error: unknown) => void;
}

/**
 * The fleet: every instance's last heartbeat, and what follows from them (which are up,
 * starting, draining or gone, deploys, restart loops, failing checks). On a control plane the
 * tenants' heartbeats arrive with their batches; on a standalone app only its own replicas beat.
 */
export class FleetRegistry {
  private readonly now: () => number;
  private readonly derive: FleetDeriveOptions;
  private readonly retentionMs: number;
  private readonly firstSeen = new Map<string, number>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly store: FleetStore,
    private readonly options: FleetRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.derive = options.derive ?? DEFAULT_DERIVE;
    this.retentionMs = options.retentionMs ?? 7 * 86_400_000;
  }

  /** How the view is derived (the alerts reuse it). */
  get deriveOptions(): FleetDeriveOptions {
    return this.derive;
  }

  /** Record one heartbeat of `app` (taken from the sender's token, never from the heartbeat). */
  async beat(app: string, heartbeat: InstanceHeartbeat): Promise<void> {
    const now = this.now();
    const id = `${app}\u0000${heartbeat.instanceId}`;
    let first = this.firstSeen.get(id);
    if (first === undefined) {
      first = now;
      this.firstSeen.set(id, first);
      if (this.firstSeen.size > 10_000) {
        this.firstSeen.delete(this.firstSeen.keys().next().value as string);
      }
    }
    const record: InstanceRecord = {
      app,
      instanceId: heartbeat.instanceId,
      host: heartbeat.host,
      pid: heartbeat.pid,
      version: heartbeat.version,
      bootedAt: Date.parse(heartbeat.bootedAt),
      firstSeenAt: first,
      // The receiver's clock decides liveness: a sender's skewed clock cannot keep it alive.
      lastSeenAt: now,
      state: heartbeat.state,
      intervalMs: heartbeat.intervalMs,
      checks: heartbeat.checks,
      shipping: heartbeat.shipping,
      url: heartbeat.url ?? null,
    };
    try {
      await this.store.upsert(record);
    } catch (error) {
      this.options.onError?.(error);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Called after every heartbeat is stored (service discovery re-checks its held callers). */
  onBeat(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The instance rows of `apps` (`null`: every app) within the retention. */
  instances(apps: readonly string[] | null = null): Promise<InstanceRecord[]> {
    return this.store.list({ apps, since: this.now() - this.retentionMs });
  }

  /** The fleet of `apps` (`null`: every app), derived now. */
  async view(apps: readonly string[] | null = null): Promise<FleetApp[]> {
    return deriveFleet(await this.instances(apps), this.now(), this.derive);
  }

  /** Delete instances past the retention, every 10 minutes (unref'd). */
  startPruning(intervalMs = 10 * 60_000): void {
    if (this.pruneTimer !== null) return;
    this.pruneTimer = setInterval(() => {
      this.store
        .prune(this.now() - this.retentionMs)
        .catch((error) => this.options.onError?.(error));
    }, intervalMs);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

/** Options of {@link InstanceReporter}. */
export interface InstanceReporterOptions {
  intervalMs: number;
  host: string;
  /** The version (resolved once, at start). */
  version: () => Promise<string | null>;
  /** This process's checks, run (cached) for each heartbeat. */
  checks?: HealthChecks | null;
  /** The shipping stats of a tenant's buffer, or `null`. */
  shipping?: () => HeartbeatShipping | null;
  /** The URL other apps reach this one at (`fleet.url`), or `null`. */
  url?: string | null;
  /** Where a heartbeat goes: the tenant's buffer, or the local registry. */
  send: (heartbeat: InstanceHeartbeat) => Promise<void> | void;
  instanceId?: string;
  bootedAt?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * This process's heartbeat: every `intervalMs` it runs the checks (cached) and sends its state,
 * `starting` until the app is ready, `draining` from the shutdown signal on.
 */
export class InstanceReporter {
  readonly instanceId: string;
  readonly bootedAt: number;
  private state: InstanceState = 'starting';
  private version: string | null = null;
  private versionResolved = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private sending: Promise<void> | null = null;
  private again = false;

  constructor(private readonly options: InstanceReporterOptions) {
    this.now = options.now ?? Date.now;
    this.bootedAt = options.bootedAt ?? this.now();
    const host = options.host.replace(/[^\x21-\x7e]/g, '-').slice(0, 64) || 'host';
    this.instanceId =
      options.instanceId ?? `${host}-${process.pid}-${randomUUID().slice(0, 8)}`.slice(0, 128);
  }

  get currentState(): InstanceState {
    return this.state;
  }

  /** Beat now, then every interval. */
  start(): void {
    if (this.timer !== null) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /** Change state and beat right away (`ready` once booted, `draining` on shutdown). */
  async setState(state: InstanceState): Promise<void> {
    if (this.state === state) return;
    this.state = state;
    await this.beat();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** The heartbeat as it stands now. */
  async build(): Promise<InstanceHeartbeat> {
    if (!this.versionResolved) {
      this.versionResolved = true;
      try {
        this.version = await this.options.version();
      } catch {
        this.version = null;
      }
    }
    const checks = this.options.checks ? await this.options.checks.run() : [];
    return {
      v: 1,
      instanceId: this.instanceId,
      host: this.options.host.slice(0, 255),
      pid: process.pid,
      version: this.version,
      bootedAt: new Date(this.bootedAt).toISOString(),
      sentAt: new Date(this.now()).toISOString(),
      state: this.state,
      intervalMs: this.options.intervalMs,
      checks,
      shipping: this.options.shipping?.() ?? null,
      ...(this.options.url ? { url: this.options.url } : {}),
    };
  }

  /** Build and send one heartbeat. Never throws; a call during a send triggers one more after it. */
  beat(): Promise<void> {
    if (this.sending !== null) {
      this.again = true;
      return this.sending;
    }
    const run = (async () => {
      do {
        this.again = false;
        try {
          await this.options.send(await this.build());
        } catch (error) {
          this.options.onError?.(error);
        }
      } while (this.again);
    })().finally(() => {
      this.sending = null;
    });
    this.sending = run;
    return run;
  }
}
