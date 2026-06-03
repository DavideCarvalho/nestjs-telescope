// packages/sqs/src/index.ts
export { SqsQueueManager } from './sqs-queue-manager.js';
export type { SqsQueueManagerOptions } from './sqs-queue-manager.js';
export type {
  SqsApproximateCounts,
  SqsDlqMessage,
  SqsOps,
  SqsQueueConfig,
} from './sqs-client.js';
export { createAwsSqsOps } from './aws-sqs-ops.js';
export type { SqsClientLike } from './aws-sqs-ops.js';
