// packages/core/src/alerts/alert-app-attribution.spec.ts
import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../entry/entry.js';
import { InMemoryStorageProvider } from '../storage/in-memory-storage-provider.js';
import { customChannel } from './alert-channel.js';
import type { AlertPayload, AlertRule, ExceptionAlertContext } from './alert-rule.js';
import { appOf } from './integrations/incident.js';
import { formatSlackMessage } from './slack-format.js';
import { TelescopeAlerter } from './telescope-alerter.js';

/**
 * On a control plane the alerter runs in the central server (`instanceId` = that server), but an
 * exception belongs to the app that recorded it (its `app:` tag). The alert must name that app,
 * not the server that evaluated the rule.
 */
const NOW = 1_000_000_000_000;

function entry(type: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id: `e-${Math.random()}`,
    batchId: 'b',
    type,
    familyHash: null,
    content: {},
    tags: [],
    sequence: 0,
    durationMs: null,
    origin: 'http',
    instanceId: 'i',
    traceId: null,
    spanId: null,
    createdAt: new Date(NOW),
    ...overrides,
  };
}

function harness(rules: AlertRule[], app?: string) {
  const storage = new InMemoryStorageProvider();
  const sent: AlertPayload[] = [];
  const alerter = new TelescopeAlerter({
    alerts: {
      channels: [customChannel(async (alert) => void sent.push(alert), 'capture')],
      dashboardUrl: null,
      intervalMs: 60_000,
      cooldownMs: 900_000,
      rules,
      geoLookup: null,
      ...(app !== undefined ? { app } : {}),
    },
    storage,
    instanceId: 'control-plane',
    droppedCount: () => 0,
    now: () => NOW,
    logger: new Logger('test'),
  });
  return { alerter, sent, storage };
}

function context(over: Partial<ExceptionAlertContext> = {}): ExceptionAlertContext {
  return {
    familyHash: 'fam-A',
    class: 'Error',
    message: 'boom',
    stack: null,
    route: '/checkout',
    method: 'POST',
    userAgent: null,
    referer: null,
    componentStack: null,
    extra: null,
    client: false,
    clientIp: null,
    geo: null,
    statusCode: 500,
    durationMs: null,
    user: null,
    occurrences: 2,
    isNew: false,
    entryId: 'ex-1',
    batchId: 'b1',
    ...over,
  };
}

function payload(exception: ExceptionAlertContext, over: Partial<AlertPayload> = {}): AlertPayload {
  return {
    rule: { type: 'every-exception' },
    value: exception.occurrences,
    threshold: 1,
    firedAt: '2026-11-17T12:00:00.000Z',
    instanceId: 'control-plane',
    exception,
    ...over,
  };
}

describe('exception alerts name the app that recorded the exception', () => {
  it('the alerter carries the `app:` tag of a server exception, null when untagged', async () => {
    const { alerter, sent, storage } = harness([{ type: 'every-exception' }]);
    const tagged = entry('exception', {
      id: 'ex-t',
      batchId: 'bt',
      familyHash: 'fam-T',
      tags: ['user:42', 'app:billing'],
      content: { class: 'TypeError', message: 'boom' },
    });
    const untagged = entry('exception', {
      id: 'ex-u',
      batchId: 'bu',
      familyHash: 'fam-U',
      content: { class: 'TypeError', message: 'boom' },
    });
    await storage.store([tagged, untagged]);
    await alerter.evaluateFlush([tagged, untagged]);
    const byFamily = new Map(sent.map((p) => [p.exception?.familyHash, p.exception?.app]));
    expect(byFamily.get('fam-T')).toBe('billing');
    expect(byFamily.get('fam-U')).toBeNull();
  });

  it("a server exception without its own tag takes its sibling request's app", async () => {
    const { alerter, sent, storage } = harness([{ type: 'every-exception' }]);
    const exception = entry('exception', {
      id: 'ex-1',
      batchId: 'b1',
      familyHash: 'fam-A',
      content: { class: 'TypeError', message: 'boom' },
    });
    const request = entry('request', {
      id: 'req-1',
      batchId: 'b1',
      tags: ['app:billing'],
      content: { method: 'GET', uri: '/x', statusCode: 500 },
    });
    await storage.store([exception, request]);
    await alerter.evaluateFlush([exception]);
    expect(sent[0]?.exception?.app).toBe('billing');
  });

  it('a client_exception carries its own `app:` tag', async () => {
    const { alerter, sent, storage } = harness([{ type: 'every-exception' }]);
    const clientError = entry('client_exception', {
      id: 'cx-1',
      batchId: 'cb1',
      familyHash: 'fam-C',
      tags: ['app:storefront'],
      content: { name: 'Error', message: 'chunk lost', url: 'https://shop.test/' },
    });
    await storage.store([clientError]);
    await alerter.evaluateFlush([clientError]);
    expect(sent[0]?.exception?.app).toBe('storefront');
  });

  it('appOf: the fleet app, else the exception app, else `alerts.app`, else the instance', () => {
    expect(appOf(payload(context({ app: 'billing' }), { app: 'hub' }))).toBe('billing');
    expect(appOf(payload(context({ app: null }), { app: 'hub' }))).toBe('hub');
    expect(appOf(payload(context({ app: null })))).toBe('control-plane');
    expect(appOf(payload(context()))).toBe('control-plane');
    expect(
      appOf(
        payload(context({ app: 'billing' }), {
          fleet: { app: 'search', detail: 'down' },
        }),
      ),
    ).toBe('search');
  });

  it('the Slack card carries an App field for the exception, and none when untagged', () => {
    const fieldsOf = (p: AlertPayload): string[] =>
      formatSlackMessage(p).blocks.flatMap((block) =>
        'fields' in block && Array.isArray(block.fields)
          ? block.fields.map((f: { text: string }) => f.text)
          : [],
      );
    expect(fieldsOf(payload(context({ app: 'billing' })))).toContainEqual(
      expect.stringMatching(/App.*billing/s),
    );
    expect(fieldsOf(payload(context({ app: null }))).some((t) => t.includes('App'))).toBe(false);
  });
});
