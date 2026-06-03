// packages/bullmq/src/queue-discovery.ts
import type { DiscoveryService } from '@nestjs/core';

/**
 * A duck-typed BullMQ `Queue`. We avoid importing `bullmq`'s `Queue` at runtime
 * (and even type-only) so this helper works whether or not the consumer's
 * esbuild/tsc setup emits the dependency — structural matching is enough to
 * read queues through the public getter API.
 */
export interface QueueLike {
  name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getJobs(
    types: string | string[],
    start?: number,
    end?: number,
    asc?: boolean,
  ): Promise<unknown[]>;
  getJob(id: string): Promise<unknown>;
  isPaused(): Promise<boolean>;
  // Mutation (present on the real bullmq Queue; optional in the structural type
  // so discovery — which only needs the read methods — stays unchanged).
  retryJobs?(opts: { state?: string; count?: number }): Promise<void>;
  add?(name: string, data: unknown, opts?: unknown): Promise<{ id?: string | null }>;
}

/**
 * Structural shape of the bullmq `Job` mutation API we drive. We never import
 * `Job` from bullmq; a single structural guard keeps the manager honest about
 * what a fetched job must expose before we mutate it.
 */
export interface JobOps {
  retry(state?: string): Promise<void>;
  remove(): Promise<void>;
  promote(): Promise<void>;
}

export function hasJobOps(value: unknown): value is JobOps {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.retry === 'function' &&
    typeof candidate.remove === 'function' &&
    typeof candidate.promote === 'function'
  );
}

export function isQueueLike(value: unknown): value is QueueLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.getJobCounts === 'function' &&
    typeof candidate.getJobs === 'function' &&
    typeof candidate.getJob === 'function' &&
    typeof candidate.isPaused === 'function'
  );
}

/** Find all BullMQ Queue instances registered in the Nest container. */
export function discoverQueues(discovery: DiscoveryService): QueueLike[] {
  const found = new Map<string, QueueLike>();
  for (const wrapper of discovery.getProviders()) {
    const instance = wrapper.instance;
    if (isQueueLike(instance) && !found.has(instance.name)) {
      found.set(instance.name, instance);
    }
  }
  return [...found.values()];
}
