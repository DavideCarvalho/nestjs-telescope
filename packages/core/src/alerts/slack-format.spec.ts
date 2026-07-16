// packages/core/src/alerts/slack-format.spec.ts
import { describe, expect, it } from 'vitest';
import type { AlertPayload, ExceptionAlertContext } from './alert-rule.js';
import { type SlackMessage, formatSlackMessage } from './slack-format.js';

function exceptionContext(overrides: Partial<ExceptionAlertContext> = {}): ExceptionAlertContext {
  return {
    familyHash: 'fam-A',
    class: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n  at a',
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
    durationMs: 1234,
    user: '42',
    occurrences: 1,
    entryId: 'ex-1',
    batchId: 'b1',
    ...overrides,
  };
}

function payload(exception: ExceptionAlertContext | undefined): AlertPayload {
  return {
    rule: { type: 'new-exception', window: '1h' },
    value: 1,
    threshold: 1,
    firedAt: '2026-01-01T00:00:00.000Z',
    instanceId: 'inst-1',
    ...(exception !== undefined ? { exception } : {}),
  };
}

/** Flatten every field label→value pair across the section blocks. */
function fieldTexts(message: SlackMessage): string[] {
  return message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'section' }> => block.type === 'section',
    )
    .flatMap((block) => block.fields ?? [])
    .map((f) => f.text);
}

/** Every section `text` body (the non-field blocks: stack, component stack, extra). */
function sectionTexts(message: SlackMessage): string[] {
  return message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'section' }> => block.type === 'section',
    )
    .map((block) => block.text?.text ?? '')
    .filter((t) => t !== '');
}

describe('formatSlackMessage — client IP', () => {
  it('renders a Client IP field for a server exception when present', () => {
    const message = formatSlackMessage(payload(exceptionContext({ clientIp: '198.51.100.9' })));
    expect(
      fieldTexts(message).some((t) => t.includes('*Client IP:*') && t.includes('198.51.100.9')),
    ).toBe(true);
  });

  it('renders a Client IP field for a client_exception when present', () => {
    const message = formatSlackMessage(
      payload(
        exceptionContext({
          client: true,
          method: null,
          statusCode: null,
          durationMs: null,
          route: 'https://app.example.com/cart',
          userAgent: 'Mozilla/5.0',
          clientIp: '203.0.113.7',
        }),
      ),
    );
    expect(
      fieldTexts(message).some((t) => t.includes('*Client IP:*') && t.includes('203.0.113.7')),
    ).toBe(true);
  });

  it('omits the Client IP field when unknown', () => {
    const message = formatSlackMessage(payload(exceptionContext({ clientIp: null })));
    expect(fieldTexts(message).some((t) => t.includes('*Client IP:*'))).toBe(false);
  });

  it('never emits a Client IP field for a rate rule (no exception context)', () => {
    const message = formatSlackMessage(payload(undefined));
    expect(fieldTexts(message).some((t) => t.includes('*Client IP:*'))).toBe(false);
  });
});

describe('formatSlackMessage — referer / geo / component stack / extra', () => {
  it('renders a Referer field when present', () => {
    const message = formatSlackMessage(
      payload(exceptionContext({ referer: 'https://app.example.com/pay' })),
    );
    expect(
      fieldTexts(message).some(
        (t) => t.includes('*Referer:*') && t.includes('https://app.example.com/pay'),
      ),
    ).toBe(true);
  });

  it('renders a Location field with a flag emoji from geo', () => {
    const message = formatSlackMessage(
      payload(
        exceptionContext({
          clientIp: '198.51.100.9',
          geo: { city: 'Reno', region: 'Nevada', country: 'United States', countryCode: 'US' },
        }),
      ),
    );
    const location = fieldTexts(message).find((t) => t.includes('*Location:*'));
    expect(location).toBeDefined();
    expect(location).toContain('Reno, Nevada, United States');
    expect(location).toContain('🇺🇸');
  });

  it('omits the Location field when geo is null', () => {
    const message = formatSlackMessage(payload(exceptionContext({ geo: null })));
    expect(fieldTexts(message).some((t) => t.includes('*Location:*'))).toBe(false);
  });

  it('renders a Component stack block for a client_exception that has one', () => {
    const message = formatSlackMessage(
      payload(exceptionContext({ client: true, componentStack: '    in Cart\n    in App' })),
    );
    expect(
      sectionTexts(message).some((t) => t.includes('*Component stack:*') && t.includes('in Cart')),
    ).toBe(true);
  });

  it('renders an Extra block as JSON when present', () => {
    const message = formatSlackMessage(
      payload(exceptionContext({ client: true, extra: { cartId: 'c-42' } })),
    );
    expect(
      sectionTexts(message).some((t) => t.includes('*Extra:*') && t.includes('"cartId": "c-42"')),
    ).toBe(true);
  });

  it('omits the Extra block when the bag is empty', () => {
    const message = formatSlackMessage(payload(exceptionContext({ client: true, extra: {} })));
    expect(sectionTexts(message).some((t) => t.includes('*Extra:*'))).toBe(false);
  });

  it('labels an every-exception alert header "Exception"', () => {
    const message = formatSlackMessage({
      rule: { type: 'every-exception' },
      value: 1,
      threshold: 1,
      firedAt: '2026-01-01T00:00:00.000Z',
      instanceId: 'inst-1',
      exception: exceptionContext(),
    });
    expect(message.text).toContain('Exception');
    expect(message.blocks[0]).toMatchObject({ type: 'header' });
  });
});

describe('formatSlackMessage — Slack section field cap', () => {
  it('keeps every section at or under 10 fields for a fully-enriched exception', () => {
    // Every context field populated: instance + observed + error + route + UA + referer +
    // duration + user + client IP + location + occurrences = 11 fields, which overflows a
    // single section's 10-field cap and makes Slack reject the whole message (invalid_blocks).
    const message = formatSlackMessage(
      payload(
        exceptionContext({
          userAgent: 'Mozilla/5.0',
          referer: 'https://app.example.com/from',
          clientIp: '198.51.100.9',
          geo: { city: 'São Paulo', region: 'SP', country: 'Brazil', countryCode: 'BR' },
        }),
      ),
    );

    const fieldSections = message.blocks.filter(
      (block): block is Extract<typeof block, { type: 'section' }> =>
        block.type === 'section' && Array.isArray(block.fields),
    );
    // The fields spilled into more than one section rather than overflowing one.
    expect(fieldSections.length).toBeGreaterThan(1);
    for (const section of fieldSections) {
      expect(section.fields?.length ?? 0).toBeLessThanOrEqual(10);
    }
    // No field was dropped in the process — all 11 are present across the sections.
    expect(fieldTexts(message).length).toBe(11);
  });
});
