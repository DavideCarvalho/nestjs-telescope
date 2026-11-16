// packages/core/src/topology/transports/index.ts
import { httpTransport } from '../transport.js';
import { bullmqTransport } from './bullmq.js';
import { redisTransport } from './redis.js';

export * from './bullmq.js';
export * from './redis.js';

/**
 * The transport drivers. A tenant sets one as `tenant.transport`; a control plane on a broker sets
 * the same driver as `transport` (it keeps its HTTP ingest route, so a fleet can mix both).
 */
export const transports = {
  http: httpTransport,
  bullmq: bullmqTransport,
  redis: redisTransport,
};
