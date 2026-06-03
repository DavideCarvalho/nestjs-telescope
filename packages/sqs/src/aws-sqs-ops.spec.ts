// packages/sqs/src/aws-sqs-ops.spec.ts
//
// Light CI-safe test for the one SDK-touching file. No AWS: we mock the client's
// `send` to assert the right SDK command instances + inputs are issued and that
// responses are narrowed correctly. This is the only place that imports the SDK
// command classes (mirroring `aws-sqs-ops.ts`).
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { type SqsClientLike, createAwsSqsOps } from './aws-sqs-ops.js';

function makeClient(send: SqsClientLike['send']): SqsClientLike {
  return { send };
}

describe('createAwsSqsOps', () => {
  it('approximateCounts issues GetQueueAttributes and parses the counts', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetQueueAttributesCommand);
      expect((command as GetQueueAttributesCommand).input).toEqual({
        QueueUrl: 'https://sqs/q',
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      });
      return {
        Attributes: {
          ApproximateNumberOfMessages: '12',
          ApproximateNumberOfMessagesNotVisible: '3',
          ApproximateNumberOfMessagesDelayed: '5',
        },
      };
    });
    const ops = createAwsSqsOps(makeClient(send));

    await expect(ops.approximateCounts('https://sqs/q')).resolves.toEqual({
      visible: 12,
      notVisible: 3,
      delayed: 5,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('receiveDlq issues ReceiveMessage (clamped, system attrs) and maps messages', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(ReceiveMessageCommand);
      expect((command as ReceiveMessageCommand).input).toMatchObject({
        QueueUrl: 'https://sqs/dlq',
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      });
      return {
        Messages: [
          {
            MessageId: 'm-1',
            Body: '{"a":1}',
            Attributes: { ApproximateReceiveCount: '2' },
          },
          { MessageId: 'm-2', Body: 'raw' },
          { Body: 'no-id-dropped' },
        ],
      };
    });
    const ops = createAwsSqsOps(makeClient(send));

    const messages = await ops.receiveDlq('https://sqs/dlq', 50);

    expect(messages).toEqual([
      { id: 'm-1', body: '{"a":1}', attributes: { ApproximateReceiveCount: '2' } },
      { id: 'm-2', body: 'raw' },
    ]);
  });

  it('redrive issues StartMessageMoveTask with source/destination ARNs', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(StartMessageMoveTaskCommand);
      expect((command as StartMessageMoveTaskCommand).input).toEqual({
        SourceArn: 'arn:dlq',
        DestinationArn: 'arn:source',
      });
      return {};
    });
    const ops = createAwsSqsOps(makeClient(send));

    await ops.redrive('arn:dlq', 'arn:source');
    expect(send).toHaveBeenCalledOnce();
  });

  it('queueArn issues GetQueueAttributes(QueueArn) and returns the ARN', async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetQueueAttributesCommand);
      expect((command as GetQueueAttributesCommand).input).toEqual({
        QueueUrl: 'https://sqs/q',
        AttributeNames: ['QueueArn'],
      });
      return { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:1:q' } };
    });
    const ops = createAwsSqsOps(makeClient(send));

    await expect(ops.queueArn('https://sqs/q')).resolves.toBe('arn:aws:sqs:us-east-1:1:q');
  });

  it('queueArn throws when the ARN attribute is absent', async () => {
    const send = vi.fn(async () => ({ Attributes: {} }));
    const ops = createAwsSqsOps(makeClient(send));

    await expect(ops.queueArn('https://sqs/q')).rejects.toThrow('Could not resolve QueueArn');
  });
});
