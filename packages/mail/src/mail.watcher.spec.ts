// packages/mail/src/mail.watcher.spec.ts
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { type MailOptions, type MailTransport, MailWatcher } from './mail.watcher.js';

interface Harness {
  ctx: WatcherContext;
  recorded: RecordInput[];
}

function makeHarness(options: { recordThrows?: boolean } = {}): Harness {
  const recorded: RecordInput[] = [];
  const ctx: WatcherContext = {
    record: (input) => {
      if (options.recordThrows) throw new Error('recorder boom');
      recorded.push(input);
    },
    runInBatch: async <T>(_origin: BatchOrigin, fn: () => Promise<T>): Promise<T> => fn(),
    beginBatch: (): BatchHandle => ({ id: 'batch', end: () => {} }),
    config: resolveConfig({}),
    moduleRef: { get: () => undefined } as unknown as WatcherContext['moduleRef'],
  };
  return { ctx, recorded };
}

function fakeTransport(impl?: (options: MailOptions) => Promise<unknown>): MailTransport {
  return {
    sendMail: impl ?? (async () => ({ messageId: '1' })),
  };
}

describe('MailWatcher', () => {
  it('has type "mail"', () => {
    expect(new MailWatcher(fakeTransport()).type).toBe('mail');
  });

  it('records a sent mail entry and returns the transport result unchanged', async () => {
    const transport = fakeTransport();
    const { ctx, recorded } = makeHarness();
    new MailWatcher(transport).register(ctx);

    const result = await transport.sendMail({
      from: 'a@x',
      to: 'b@y',
      subject: 'hi',
      text: 'yo',
    });

    expect(result).toEqual({ messageId: '1' });
    expect(recorded).toHaveLength(1);
    const entry = recorded[0]!;
    expect(entry.type).toBe('mail');
    expect(entry.content).toMatchObject({
      mailer: 'nodemailer',
      from: 'a@x',
      to: ['b@y'],
      subject: 'hi',
      preview: 'yo',
      status: 'sent',
    });
    expect(entry.familyHash).toBe('nodemailer');
  });

  it('normalizes an array of recipients', async () => {
    const transport = fakeTransport();
    const { ctx, recorded } = makeHarness();
    new MailWatcher(transport).register(ctx);

    await transport.sendMail({ to: ['a@x', 'b@y'], subject: 's' });

    expect(recorded[0]!.content).toMatchObject({ to: ['a@x', 'b@y'] });
  });

  it('honors a per-message mailer override and the watcher default option', async () => {
    const transport = fakeTransport();
    const { ctx, recorded } = makeHarness();
    new MailWatcher(transport, { mailer: 'ses' }).register(ctx);

    await transport.sendMail({ to: 'b@y', mailer: 'mailgun' });
    await transport.sendMail({ to: 'c@y' });

    expect(recorded[0]!.content).toMatchObject({ mailer: 'mailgun' });
    expect(recorded[1]!.content).toMatchObject({ mailer: 'ses' });
  });

  it('records a failed mail entry and re-throws when the transport rejects', async () => {
    const transport = fakeTransport(async () => {
      throw new Error('SMTP down');
    });
    const { ctx, recorded } = makeHarness();
    new MailWatcher(transport).register(ctx);

    await expect(transport.sendMail({ to: 'b@y', subject: 'hi' })).rejects.toThrow('SMTP down');

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.content).toMatchObject({ status: 'failed', to: ['b@y'] });
    expect(recorded[0]!.tags).toContain('failed');
  });

  it('wraps sendMail exactly once across repeated register calls', async () => {
    const transport = fakeTransport();
    const { ctx, recorded } = makeHarness();
    const watcher = new MailWatcher(transport);
    watcher.register(ctx);
    watcher.register(ctx);

    await transport.sendMail({ to: 'b@y' });

    expect(recorded).toHaveLength(1);
  });

  it('never corrupts the send outcome when ctx.record throws', async () => {
    const okTransport = fakeTransport();
    const okHarness = makeHarness({ recordThrows: true });
    new MailWatcher(okTransport).register(okHarness.ctx);
    await expect(okTransport.sendMail({ to: 'b@y' })).resolves.toEqual({ messageId: '1' });

    const boomTransport = fakeTransport(async () => {
      throw new Error('SMTP down');
    });
    const boomHarness = makeHarness({ recordThrows: true });
    new MailWatcher(boomTransport).register(boomHarness.ctx);
    await expect(boomTransport.sendMail({ to: 'b@y' })).rejects.toThrow('SMTP down');
  });
});
