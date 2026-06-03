// packages/sqs/src/sqs-client.ts
//
// The `SqsOps` port. The `SqsQueueManager` depends ONLY on this interface, so it
// is 100% unit-testable with a mock and AWS-free in CI. The single concrete
// implementation that talks to `@aws-sdk/client-sqs` lives in `aws-sqs-ops.ts`
// (`createAwsSqsOps`) — keeping the SDK import in exactly one optional file. A
// host may supply their own `SqsOps` instead.

/** A DLQ message snapshotted via ReceiveMessage. */
export interface SqsDlqMessage {
  /** SQS `MessageId`. */
  id: string;
  /** Raw message `Body` (typically a JSON string). */
  body: string;
  /**
   * System/queue attributes returned for the message — notably
   * `ApproximateReceiveCount`. Absent keys are simply not present.
   */
  attributes?: Record<string, string>;
}

/** Approximate queue depth, read from `GetQueueAttributes`. */
export interface SqsApproximateCounts {
  /** `ApproximateNumberOfMessages` — visible (deliverable) messages. */
  visible: number;
  /** `ApproximateNumberOfMessagesNotVisible` — in-flight messages. */
  notVisible: number;
  /** `ApproximateNumberOfMessagesDelayed` — delayed (not yet deliverable) messages. */
  delayed: number;
}

/**
 * The minimal set of SQS operations the manager needs. Intentionally small and
 * AWS-type-free so it can be mocked in tests and re-implemented by hosts.
 */
export interface SqsOps {
  /** Approximate visible / in-flight counts for a queue (by URL). */
  approximateCounts(queueUrl: string): Promise<SqsApproximateCounts>;
  /**
   * Snapshot up to `max` (≤ 10) DLQ messages via ReceiveMessage. This does NOT
   * delete them — they reappear after the visibility timeout — so it is a
   * best-effort peek, not a drain.
   */
  receiveDlq(dlqUrl: string, max: number): Promise<SqsDlqMessage[]>;
  /**
   * Start a native message-move task that redrives the DLQ back to its source
   * (`StartMessageMoveTask` with `SourceArn = dlqArn`, `DestinationArn = sourceArn`).
   */
  redrive(dlqArn: string, sourceArn: string): Promise<void>;
  /** Resolve a queue's ARN (`QueueArn` attribute) from its URL. */
  queueArn(queueUrl: string): Promise<string>;
}

/**
 * A queue the manager exposes: its name plus its source URL, and an OPTIONAL
 * DLQ URL.
 *
 * DLQs are optional in AWS — many real queues have none. Without `dlqUrl` the
 * manager still reports live depth (waiting/active/delayed) from the main queue;
 * `dlqUrl` only adds DLQ inspection (`listJobs('failed')`) and `redrive`.
 */
export interface SqsQueueConfig {
  /** Display name used as the queue identifier in the dashboard. */
  name: string;
  /** Source queue URL. */
  url: string;
  /** Dead-letter queue URL. Optional — omit for queues that have no DLQ. */
  dlqUrl?: string;
}
