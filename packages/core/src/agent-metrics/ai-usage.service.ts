// packages/core/src/agent-metrics/ai-usage.service.ts
import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Entry } from '../entry/entry.js';
import { collectEntriesInWindow } from '../metrics/collect-window.js';
import {
  TELESCOPE_OPTIONS,
  TELESCOPE_STORAGE,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { AgentMetricsRegistry } from './agent-metrics.js';
import { type AiUsageSummary, summarizeAiUsage } from './ai-usage.js';
import { subscribeAgentObservations } from './subscribe-agent-events.js';

export interface AiUsageQuery {
  windowMs: number;
  buckets?: number;
  top?: number;
  runsLimit?: number;
}

export interface AiUsageResult extends AiUsageSummary {
  scanned: number;
  truncated: boolean;
}

/**
 * Backs the dashboard's AI screen (`GET <path>/api/ai`) from stored agent entries, and — when
 * `aiMetrics.prometheus` is on — keeps the in-process {@link AgentMetricsRegistry} the
 * `GET <path>/api/metrics` scrape reads, fed straight from the agent's diagnostics channels.
 */
@Injectable()
export class AiUsageService implements OnModuleInit, OnApplicationShutdown {
  private readonly registry = new AgentMetricsRegistry();
  private unsubscribe: (() => void) | null = null;

  constructor(
    @Inject(TELESCOPE_STORAGE) private readonly storage: StorageProvider,
    @Optional() @Inject(TELESCOPE_OPTIONS) private readonly options?: TelescopeModuleOptions,
  ) {}

  /** Whether the Prometheus scrape endpoint is on (`aiMetrics.prometheus`). */
  get prometheusEnabled(): boolean {
    return this.options?.aiMetrics?.prometheus === true;
  }

  onModuleInit(): void {
    if (!this.prometheusEnabled || this.options?.enabled === false) return;
    this.unsubscribe = subscribeAgentObservations((o) => this.registry.observe(o));
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The Prometheus exposition of the agent metrics. */
  prometheus(): string {
    return this.registry.prometheus();
  }

  async getUsage(query: AiUsageQuery): Promise<AiUsageResult> {
    if (!Number.isFinite(query.windowMs) || query.windowMs <= 0) {
      throw new RangeError(`windowMs must be a positive, finite number (got ${query.windowMs}).`);
    }
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - query.windowMs);
    // Both shapes an agent event can be stored in: the agent's own watcher (`agent`) and the
    // generic diagnostics bridge (`diagnostic`, filtered to lib `agent` by the summarizer).
    const reads = await Promise.all(
      ['agent', 'diagnostic'].map((type) =>
        collectEntriesInWindow(this.storage, { type, after: windowStart }),
      ),
    );
    const entries: Entry[] = reads.flatMap((r) => r.entries);
    const summary = summarizeAiUsage(entries, {
      windowStart,
      windowEnd,
      ...(query.buckets !== undefined ? { buckets: query.buckets } : {}),
      ...(query.top !== undefined ? { top: query.top } : {}),
      ...(query.runsLimit !== undefined ? { runsLimit: query.runsLimit } : {}),
    });
    return {
      ...summary,
      scanned: reads.reduce((n, r) => n + r.scanned, 0),
      truncated: reads.some((r) => r.truncated),
    };
  }
}
