import diagnostics_channel from 'node:diagnostics_channel';
import {
  type BatchHandle,
  type BatchOrigin,
  type RecordInput,
  type WatcherContext,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NestAuthWatcher,
  authenticationEntry,
  authorizationEntry,
  fingerprint,
  maskEmail,
} from './auth.watcher.js';
import { ChannelWatcher, eventOf } from './channel-watcher.js';
import { WORKFLOW_EVENT_TYPES } from './channels.js';
import { NestMailWatcher, mailEntry } from './mail.watcher.js';
import { officialWatchers } from './official-watchers.js';
import { NestResilienceWatcher, resilienceEntry } from './resilience.watcher.js';
import { NestWorkflowsWatcher, workflowEntry } from './workflows.watcher.js';

function harness(options: { recordThrows?: boolean } = {}) {
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

const live: ChannelWatcher[] = [];
afterEach(() => {
  for (const w of live.splice(0)) w.unregister();
});
function track<W extends ChannelWatcher>(w: W): W {
  live.push(w);
  return w;
}

describe('ChannelWatcher', () => {
  it('records published messages, once per register, and stops after unregister', () => {
    const { ctx, recorded } = harness();
    const w = track(new NestResilienceWatcher());
    w.register(ctx);
    w.register(ctx);
    diagnostics_channel.channel('nestjs:resilience:retry').publish({
      type: 'retry',
      policy: 'p',
      attempt: 1,
      delayMs: 5,
      error: new Error('x'),
    });
    expect(recorded).toHaveLength(1);
    w.unregister();
    diagnostics_channel.channel('nestjs:resilience:retry').publish({ type: 'retry', policy: 'p' });
    expect(recorded).toHaveLength(1);
  });

  it('never lets a mapper or record failure reach the publisher', () => {
    const boom = track(
      new ChannelWatcher('x', ['telescope-test:boom'], () => {
        throw new Error('mapper boom');
      }),
    );
    boom.register(harness().ctx);
    expect(() => diagnostics_channel.channel('telescope-test:boom').publish({})).not.toThrow();

    const w = track(new NestMailWatcher());
    w.register(harness({ recordThrows: true }).ctx);
    expect(() =>
      diagnostics_channel.channel('nestjs:mail:sent').publish({ type: 'sent', recipients: [] }),
    ).not.toThrow();
  });

  it('eventOf strips the nestjs:<lib>: prefix', () => {
    expect(eventOf('nestjs:workflows:step-failed')).toBe('step-failed');
    expect(eventOf('plain')).toBe('plain');
  });
});

describe('officialWatchers', () => {
  it('returns one watcher per package, each switchable off', () => {
    expect(officialWatchers().map((w) => w.type)).toEqual([
      'resilience',
      'workflow',
      'auth',
      'mail',
    ]);
    expect(officialWatchers({ mail: false, workflows: false }).map((w) => w.type)).toEqual([
      'resilience',
      'auth',
    ]);
    const [auth] = officialWatchers({
      resilience: false,
      workflows: false,
      mail: false,
      auth: { authentication: false },
    }) as NestAuthWatcher[];
    expect(auth?.channelNames).toEqual(['nestjs:authorization:denied']);
  });
});

describe('resilienceEntry', () => {
  it('maps each event type and tags refusals failed', () => {
    const open = resilienceEntry('nestjs:resilience:circuit-open', {
      type: 'circuit-open',
      policy: 'payments',
      source: 'Pay.charge',
      from: 'closed',
      to: 'open',
    })!;
    expect(open).toMatchObject({
      type: 'resilience',
      familyHash: 'circuit-open:payments',
      content: { event: 'circuit-open', policy: 'payments', source: 'Pay.charge', from: 'closed' },
    });
    expect(open.tags).toEqual(['resilience:circuit-open', 'failed']);
    const bulkhead = resilienceEntry('nestjs:resilience:bulkhead-rejected', {
      type: 'bulkhead-rejected',
      policy: 'b',
      reason: 'full',
      active: 3,
      queued: 2,
    })!;
    expect(bulkhead.content).toMatchObject({ reason: 'full', active: 3, queued: 2 });
    const fallback = resilienceEntry('nestjs:resilience:fallback', { policy: 'f', error: 'nope' })!;
    expect(fallback.content).toMatchObject({ event: 'fallback', error: { message: 'nope' } });
    expect(fallback.tags).toEqual(['resilience:fallback']);
  });

  it('ignores non-object payloads and unknown fields', () => {
    expect(resilienceEntry('nestjs:resilience:retry', null)).toBeNull();
    expect(resilienceEntry('nestjs:resilience:retry', 'x')).toBeNull();
    const e = resilienceEntry('nestjs:resilience:retry', {
      policy: 'p',
      secret: 's',
      attempt: 'two',
    })!;
    expect(e.content).toEqual({ event: 'retry', policy: 'p' });
  });
});

describe('workflowEntry', () => {
  it('maps every one of the 19 event types', () => {
    for (const type of WORKFLOW_EVENT_TYPES) {
      const entry = workflowEntry(`nestjs:workflows:${type}`, {
        type,
        id: 'i-1',
        workflow: 'ship',
        version: 1,
        at: 1,
      })!;
      expect(entry.content).toMatchObject({ event: type, id: 'i-1', workflow: 'ship', version: 1 });
      expect(entry.familyHash).toBe('ship');
    }
  });

  it('keeps step timing as the entry duration and serializes the error without its stack', () => {
    const failed = workflowEntry('nestjs:workflows:step-failed', {
      type: 'step-failed',
      id: 'i',
      workflow: 'w',
      version: 1,
      at: 1,
      step: 'charge',
      attempt: 2,
      retryAt: null,
      error: { name: 'StepFailedError', message: 'card declined', stack: 'at …' },
    })!;
    expect(failed.tags).toEqual(['workflow:step-failed', 'failed']);
    expect(failed.content).toMatchObject({
      step: 'charge',
      attempt: 2,
      error: { name: 'StepFailedError', message: 'card declined' },
    });
    expect(JSON.stringify(failed.content)).not.toContain('at …');
    const done = workflowEntry('nestjs:workflows:step-completed', {
      type: 'step-completed',
      workflow: 'w',
      durationMs: 42,
    })!;
    expect(done.durationMs).toBe(42);
  });

  it('keeps schedule-skipped and retried fields', () => {
    const skipped = workflowEntry('nestjs:workflows:schedule-skipped', {
      type: 'schedule-skipped',
      workflow: 'w',
      reason: 'overlap',
      from: 10,
      to: 20,
    })!;
    expect(skipped.content).toMatchObject({ reason: 'overlap', from: 10, to: 20 });
    const retried = workflowEntry('nestjs:workflows:workflow-retried', {
      type: 'workflow-retried',
      workflow: 'w',
      from: 'failed',
      error: null,
    })!;
    expect(retried.content).toMatchObject({ from: 'failed' });
    expect(retried.content).not.toHaveProperty('error');
  });
});

describe('authenticationEntry (redaction)', () => {
  it('fingerprints session and token-family ids, masks email, keeps only metadata keys', () => {
    const e = authenticationEntry('nestjs:authentication:sign-in', {
      type: 'sign-in',
      userId: 'u1',
      sessionId: 'sess-secret-123',
      tokenFamilyId: 'fam-secret-456',
      method: 'password',
      mfa: 'pending',
      metadata: { ip: '1.2.3.4', ua: 'x' },
    })!;
    expect(e.content).toEqual({
      source: 'authentication',
      event: 'sign-in',
      userId: 'u1',
      method: 'password',
      mfa: 'pending',
      sessionRef: fingerprint('sess-secret-123'),
      tokenFamilyRef: fingerprint('fam-secret-456'),
      metadataKeys: ['ip', 'ua'],
    });
    expect(JSON.stringify(e)).not.toMatch(/sess-secret|fam-secret|1\.2\.3\.4/);
  });

  it('never copies an unknown field (a token or password a later version might add)', () => {
    const e = authenticationEntry('nestjs:authentication:password-reset-requested', {
      type: 'password-reset-requested',
      email: 'Jane.Doe@Example.com',
      token: 'reset-token',
      password: 'hunter2',
      accessToken: 'jwt',
    })!;
    expect(e.content).toEqual({
      source: 'authentication',
      event: 'password-reset-requested',
      email: 'J***@Example.com',
    });
  });

  it('tags security signals failed and keeps the error message of a touch failure', () => {
    const e = authenticationEntry('nestjs:authentication:session-touch-failed', {
      type: 'session-touch-failed',
      userId: 'u',
      sessionId: 's',
      error: new Error('lock timeout'),
    })!;
    expect(e.tags).toEqual(['auth:session-touch-failed', 'failed']);
    expect(e.content).toMatchObject({ error: { name: 'Error', message: 'lock timeout' } });
    const mfa = authenticationEntry('nestjs:authentication:mfa-failed', {
      type: 'mfa-failed',
      userId: 'u',
      method: 'totp',
      failures: 3,
      locked: true,
    })!;
    expect(mfa.content).toMatchObject({ failures: 3, locked: true, method: 'totp' });
  });

  it('maskEmail / fingerprint', () => {
    expect(maskEmail('a@b.c')).toBe('a***@b.c');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(fingerprint('x')).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fingerprint('x')).toBe(fingerprint('x'));
  });
});

describe('authorizationEntry', () => {
  it('keeps the user id and arg count, never the user or the records', () => {
    const e = authorizationEntry('nestjs:authorization:denied', {
      type: 'denied',
      policy: 'OrderPolicy',
      ability: 'refund',
      reason: 'forbidden',
      user: { id: 7, email: 'a@b.c', passwordHash: 'x' },
      args: [{ id: 'o1', card: '4242' }],
      handler: 'Orders.refund',
    })!;
    expect(e.content).toEqual({
      source: 'authorization',
      event: 'denied',
      policy: 'OrderPolicy',
      ability: 'refund',
      reason: 'forbidden',
      handler: 'Orders.refund',
      userId: '7',
      argCount: 1,
    });
    expect(e.familyHash).toBe('denied:OrderPolicy.refund');
    expect(e.tags).toContain('failed');
  });

  it('a handler with no check: null policy and ability', () => {
    const e = authorizationEntry('nestjs:authorization:denied', {
      type: 'denied',
      policy: null,
      ability: null,
      reason: 'unauthenticated',
      user: null,
      args: [],
    })!;
    expect(e.content).toMatchObject({ policy: null, ability: null, argCount: 0 });
    expect(e.familyHash).toBe('denied:none.none');
  });

  it('the auth watcher routes each channel to its mapper', () => {
    const { ctx, recorded } = harness();
    track(new NestAuthWatcher()).register(ctx);
    diagnostics_channel
      .channel('nestjs:authorization:denied')
      .publish({ type: 'denied', policy: 'P', ability: 'a', reason: 'forbidden', args: [] });
    diagnostics_channel
      .channel('nestjs:authentication:mfa-disabled')
      .publish({ type: 'mfa-disabled', userId: 'u' });
    expect(recorded.map((r) => (r.content as { source: string }).source)).toEqual([
      'authorization',
      'authentication',
    ]);
  });
});

describe('mailEntry', () => {
  it('maps sent to the built-in mail entry shape', () => {
    const e = mailEntry('nestjs:mail:sent', {
      type: 'sent',
      messageId: '<1@x>',
      mail: 'WelcomeMail',
      recipients: ['a@x', 'b@y'],
      subject: 'Hi',
      transport: 'SmtpTransport',
      attempts: 1,
      durationMs: 12,
      providerMessageId: 'p-1',
    })!;
    expect(e).toMatchObject({
      type: 'mail',
      familyHash: 'WelcomeMail',
      durationMs: 12,
      content: {
        mailer: '@nestjs/mail',
        from: null,
        to: ['a@x', 'b@y'],
        subject: 'Hi',
        preview: null,
        status: 'sent',
        mail: 'WelcomeMail',
        providerMessageId: 'p-1',
      },
    });
    expect(e.tags).toBeUndefined();
  });

  it('maps failed with permanence and the error', () => {
    const e = mailEntry('nestjs:mail:failed', {
      type: 'failed',
      recipients: ['a@x'],
      subject: 's',
      permanent: true,
      error: { name: 'MailError', message: '550 no such user', code: 550 },
    })!;
    expect(e.tags).toEqual(['failed']);
    expect(e.familyHash).toBe('@nestjs/mail');
    expect(e.content).toMatchObject({
      status: 'failed',
      permanent: true,
      error: { name: 'MailError', message: '550 no such user', code: 550 },
    });
  });
});

describe('NestWorkflowsWatcher', () => {
  it('subscribes to every workflow channel', () => {
    expect(new NestWorkflowsWatcher().channelNames).toHaveLength(19);
  });
});
