// packages/sqs/src/aws-sqs-ops.ts
//
// The ONE file that imports `@aws-sdk/client-sqs`. It is optional: hosts that
// already have an `SQSClient` call `createAwsSqsOps(client)`; hosts that don't
// want the SDK dependency at all can implement `SqsOps` themselves and never
// import this module. `@aws-sdk/client-sqs` is a devDependency only (for these
// command types) — there is no hard runtime dependency on the SDK.
import {
  GetQueueAttributesCommand,
  type QueueAttributeName,
  ReceiveMessageCommand,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import type { SqsApproximateCounts, SqsDlqMessage, SqsOps } from './sqs-client.js';

/**
 * Structural `SQSClient`: only `send` is used. Duck-typing keeps `createAwsSqsOps`
 * tolerant of SDK minor-version drift and avoids a hard value import of the
 * client class. The command instances we pass are the real SDK commands, so the
 * client routes them correctly.
 */
export interface SqsClientLike {
  send(command: unknown): Promise<unknown>;
}

function readNumberAttribute(attributes: Record<string, string> | undefined, key: string): number {
  const raw = attributes?.[key];
  if (typeof raw !== 'string') return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readStringAttribute(
  attributes: Record<string, string> | undefined,
  key: string,
): string | undefined {
  const raw = attributes?.[key];
  return typeof raw === 'string' ? raw : undefined;
}

/** Narrow an unknown SDK response to the attributes bag we read. */
function asAttributes(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const bag: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') bag[key] = entry;
  }
  return bag;
}

/** Narrow an unknown SDK ReceiveMessage response into our message shape. */
function toDlqMessages(value: unknown): SqsDlqMessage[] {
  if (typeof value !== 'object' || value === null) return [];
  const messages = (value as { Messages?: unknown }).Messages;
  if (!Array.isArray(messages)) return [];
  const result: SqsDlqMessage[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const id = (message as { MessageId?: unknown }).MessageId;
    const body = (message as { Body?: unknown }).Body;
    if (typeof id !== 'string' || typeof body !== 'string') continue;
    const attributes = asAttributes((message as { Attributes?: unknown }).Attributes);
    result.push(attributes ? { id, body, attributes } : { id, body });
  }
  return result;
}

/**
 * Build a default `SqsOps` from an `@aws-sdk/client-sqs` `SQSClient` (or any
 * structurally compatible client). This is the only place the SDK is touched.
 */
export function createAwsSqsOps(client: SqsClientLike): SqsOps {
  async function readAttributes(
    queueUrl: string,
    names: QueueAttributeName[],
  ): Promise<Record<string, string> | undefined> {
    const response = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: names }),
    );
    if (typeof response !== 'object' || response === null) return undefined;
    return asAttributes((response as { Attributes?: unknown }).Attributes);
  }

  return {
    async approximateCounts(queueUrl: string): Promise<SqsApproximateCounts> {
      const attributes = await readAttributes(queueUrl, [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ]);
      return {
        visible: readNumberAttribute(attributes, 'ApproximateNumberOfMessages'),
        notVisible: readNumberAttribute(attributes, 'ApproximateNumberOfMessagesNotVisible'),
        delayed: readNumberAttribute(attributes, 'ApproximateNumberOfMessagesDelayed'),
      };
    },

    async receiveDlq(dlqUrl: string, max: number): Promise<SqsDlqMessage[]> {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: Math.min(Math.max(max, 1), 10),
          // A short visibility timeout: we only peek, so let messages reappear
          // promptly for real consumers.
          VisibilityTimeout: 1,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      return toDlqMessages(response);
    },

    async redrive(dlqArn: string, sourceArn: string): Promise<void> {
      await client.send(
        new StartMessageMoveTaskCommand({
          SourceArn: dlqArn,
          DestinationArn: sourceArn,
        }),
      );
    },

    async queueArn(queueUrl: string): Promise<string> {
      const attributes = await readAttributes(queueUrl, ['QueueArn']);
      const arn = readStringAttribute(attributes, 'QueueArn');
      if (!arn) throw new Error(`Could not resolve QueueArn for ${queueUrl}`);
      return arn;
    },
  };
}
