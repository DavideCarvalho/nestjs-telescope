// packages/core/test/alerts/integrations/on-call.spec.ts
import { describe, expect, it } from 'vitest';
import { incidentKey, severityOf } from '../../../src/alerts/integrations/incident.js';
import {
  betterStackIncidentChannel,
  grafanaOnCallChannel,
  incidentIoChannel,
  opsgenieChannel,
  pagerDutyChannel,
} from '../../../src/alerts/integrations/on-call.js';
import { exceptionAlert, fakeSleep, metricAlert, mockFetch } from './helpers.js';

describe('incident key and severity', () => {
  it('is the same for the firing and the resolving notification of a rule', () => {
    expect(incidentKey(metricAlert('firing'))).toBe(incidentKey(metricAlert('resolved')));
    expect(incidentKey(metricAlert())).toBe(
      'telescope:web-1:metric-threshold:request-p99-ms:gte:500:5m',
    );
  });

  it('is per app (alerts.app over instanceId) and per exception family', () => {
    expect(incidentKey({ ...metricAlert(), app: 'api' })).toBe(
      'telescope:api:metric-threshold:request-p99-ms:gte:500:5m',
    );
    // Two replicas with the same `app` fold into one incident.
    expect(incidentKey({ ...metricAlert(), app: 'api', instanceId: 'web-2' })).toBe(
      incidentKey({ ...metricAlert(), app: 'api' }),
    );
    expect(incidentKey(exceptionAlert())).toBe('telescope:web-1:new-exception:1h:fam-A');
    expect(incidentKey({ ...exceptionAlert(), rule: { type: 'every-exception' } })).not.toBe(
      incidentKey(exceptionAlert()),
    );
  });

  it('defaults by rule kind and honours the rule override', () => {
    expect(severityOf(metricAlert())).toBe('warning');
    expect(severityOf(exceptionAlert())).toBe('error');
    const critical = metricAlert();
    critical.rule = { ...critical.rule, severity: 'critical' };
    expect(severityOf(critical)).toBe('critical');
  });
});

describe('pagerDutyChannel', () => {
  it('triggers then resolves with the same dedup_key', async () => {
    const { fetch, calls } = mockFetch();
    const channel = pagerDutyChannel({ routingKey: 'R0UTING', fetch });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));

    expect(calls[0]?.url).toBe('https://events.pagerduty.com/v2/enqueue');
    const trigger = calls[0]?.json as Record<string, any>;
    expect(trigger.event_action).toBe('trigger');
    expect(trigger.routing_key).toBe('R0UTING');
    expect(trigger.payload.severity).toBe('warning');
    expect(trigger.payload.source).toBe('web-1');
    expect(trigger.payload.summary).toContain('request-p99-ms = 812.500');
    expect(trigger.links[0].href).toBe('https://telescope.example');

    const resolve = calls[1]?.json as Record<string, any>;
    expect(resolve).toEqual({
      routing_key: 'R0UTING',
      event_action: 'resolve',
      dedup_key: trigger.dedup_key,
    });
  });

  it('retries a 5xx with backoff', async () => {
    const { fetch, calls } = mockFetch([{ status: 500 }, { status: 202 }]);
    const { sleep, delays } = fakeSleep();
    await pagerDutyChannel({ routingKey: 'k', fetch, sleep }).send(metricAlert());
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });
});

describe('fail closed at boot', () => {
  it('names the missing field, never a value', () => {
    expect(() => pagerDutyChannel({ routingKey: ' ' })).toThrow(
      "Telescope alert channel 'pagerduty': missing routingKey",
    );
    expect(() => opsgenieChannel({ apiKey: '' })).toThrow('missing apiKey');
    expect(() =>
      betterStackIncidentChannel({ apiToken: 'secret-token', requesterEmail: '' }),
    ).toThrow(/missing requesterEmail$/);
    expect(() => incidentIoChannel({ alertSourceConfigId: '', token: '' })).toThrow(
      'missing alertSourceConfigId, token',
    );
  });
});

describe('opsgenieChannel', () => {
  it('creates with alias + priority and closes by alias', async () => {
    const { fetch, calls } = mockFetch();
    const channel = opsgenieChannel({ apiKey: 'G3NIE', region: 'eu', fetch });
    const firing = exceptionAlert();
    await channel.send(firing);
    await channel.send({ ...firing, status: 'resolved' });

    expect(calls[0]?.url).toBe('https://api.eu.opsgenie.com/v2/alerts');
    expect(calls[0]?.headers.authorization).toBe('GenieKey G3NIE');
    const body = calls[0]?.json as Record<string, any>;
    expect(body.alias).toBe(incidentKey(firing));
    expect(body.priority).toBe('P2');
    expect(body.message.length).toBeLessThanOrEqual(130);
    expect(body.tags).toEqual(['telescope', 'error']);

    expect(calls[1]?.url).toBe(
      `https://api.eu.opsgenie.com/v2/alerts/${encodeURIComponent(incidentKey(firing))}/close?identifierType=alias`,
    );
  });
});

describe('betterStackIncidentChannel', () => {
  it('creates one incident per key, then resolves it by id', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, json: { data: { id: '987' } } }]);
    const channel = betterStackIncidentChannel({
      apiToken: 'BST',
      requesterEmail: 'ops@example.com',
      fetch,
    });
    const critical = metricAlert();
    critical.rule = { ...critical.rule, severity: 'critical' };
    await channel.send(critical);
    await channel.send(critical); // still open: not paged twice
    await channel.send({ ...critical, status: 'resolved' });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://incidents.betterstack.com/api/v3/incidents');
    expect(calls[0]?.headers.authorization).toBe('Bearer BST');
    expect(calls[0]?.json).toMatchObject({
      requester_email: 'ops@example.com',
      call: true,
      sms: true,
      email: true,
    });
    expect(calls[1]?.url).toBe('https://incidents.betterstack.com/api/v3/incidents/987/resolve');
  });

  it('skips a resolve it has no incident for', async () => {
    const { fetch, calls } = mockFetch();
    await betterStackIncidentChannel({ apiToken: 't', requesterEmail: 'a@b.c', fetch }).send(
      metricAlert('resolved'),
    );
    expect(calls).toHaveLength(0);
  });
});

describe('incidentIoChannel', () => {
  it('sends firing and resolved alert events with the dedup key', async () => {
    const { fetch, calls } = mockFetch();
    const channel = incidentIoChannel({ alertSourceConfigId: 'SRC1', token: 'IIO', fetch });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));
    expect(calls[0]?.url).toBe('https://api.incident.io/v2/alert_events/http/SRC1');
    expect(calls[0]?.headers.authorization).toBe('Bearer IIO');
    expect(calls[0]?.json).toMatchObject({
      status: 'firing',
      deduplication_key: incidentKey(metricAlert()),
      source_url: 'https://telescope.example',
    });
    expect(calls[1]?.json).toMatchObject({ status: 'resolved' });
  });
});

describe('grafanaOnCallChannel', () => {
  it('maps firing → alerting and resolved → ok under one alert_uid', async () => {
    const { fetch, calls } = mockFetch();
    const channel = grafanaOnCallChannel({
      url: 'https://oncall.example/integrations/v1/formatted_webhook/T/',
      fetch,
    });
    await channel.send(metricAlert('firing'));
    await channel.send(metricAlert('resolved'));
    const [a, b] = calls.map((c) => c.json as Record<string, unknown>);
    expect(a?.state).toBe('alerting');
    expect(b?.state).toBe('ok');
    expect(a?.alert_uid).toBe(b?.alert_uid);
    // Only the fields the Formatted Webhook reads; severity rides in the title.
    expect(Object.keys(a ?? {}).sort()).toEqual([
      'alert_uid',
      'link_to_upstream_details',
      'message',
      'state',
      'title',
    ]);
    expect(a?.title).toMatch(/^\[warning\] /);
  });
});

describe('timeouts', () => {
  const hung = (_url: string, init: { signal: AbortSignal }) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

  it('every on-call channel gives up on a hung endpoint with a URL-free error', async () => {
    const opts = { fetch: hung, timeoutMs: 10, retries: 0 };
    const channels = [
      pagerDutyChannel({ routingKey: 'SECRET', ...opts }),
      opsgenieChannel({ apiKey: 'SECRET', ...opts }),
      betterStackIncidentChannel({ apiToken: 'SECRET', requesterEmail: 'a@b.c', ...opts }),
      incidentIoChannel({ alertSourceConfigId: 'SECRET', token: 'SECRET', ...opts }),
      grafanaOnCallChannel({ url: 'https://oncall.example/SECRET', ...opts }),
    ];
    for (const channel of channels) {
      const error = await channel.send(metricAlert()).catch((e: Error) => e);
      expect((error as Error).message).toBe('timed out after 10ms');
    }
  });
});
