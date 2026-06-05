// packages/ai/src/prompt.spec.ts
import type { DiagnoseContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

function context(overrides: Partial<DiagnoseContext> = {}): DiagnoseContext {
  return {
    exceptionClass: 'RangeError',
    message: 'index out of bounds',
    stack: 'RangeError: index out of bounds\n    at f (a.ts:1)',
    request: { route: '/api/x', method: 'GET', statusCode: 500, durationMs: 12 },
    url: null,
    userAgent: null,
    recentQueries: [],
    client: false,
    occurrenceCount: 1,
    ...overrides,
  };
}

describe('SYSTEM_PROMPT', () => {
  it('pins the four-section markdown contract', () => {
    expect(SYSTEM_PROMPT).toContain('## Probable root cause');
    expect(SYSTEM_PROMPT).toContain('## Where to look');
    expect(SYSTEM_PROMPT).toContain('## Suggested fix');
    expect(SYSTEM_PROMPT).toContain('## Confidence');
  });
});

describe('buildUserPrompt', () => {
  it('includes class, message, route and stack for a server exception', () => {
    const prompt = buildUserPrompt(context());
    expect(prompt).toContain('RangeError: index out of bounds');
    expect(prompt).toContain('GET /api/x');
    expect(prompt).toContain('Status: 500');
    expect(prompt).toContain('at f (a.ts:1)');
  });

  it('lists recent queries as a bullet list', () => {
    const prompt = buildUserPrompt(context({ recentQueries: ['select 1', 'select 2'] }));
    expect(prompt).toContain('- select 1');
    expect(prompt).toContain('- select 2');
  });

  it('omits the occurrence line for a single occurrence', () => {
    expect(buildUserPrompt(context({ occurrenceCount: 1 }))).not.toContain('Occurrences');
    expect(buildUserPrompt(context({ occurrenceCount: 5 }))).toContain(
      'Occurrences (last window): 5',
    );
  });

  it('notes a missing stack rather than omitting it', () => {
    expect(buildUserPrompt(context({ stack: null }))).toContain('Stack: (none captured)');
  });

  it('uses page URL + user agent for a client exception', () => {
    const prompt = buildUserPrompt(
      context({
        client: true,
        request: null,
        url: 'https://x.test/page',
        userAgent: 'UA/1.0',
      }),
    );
    expect(prompt).toContain('browser (client-side)');
    expect(prompt).toContain('Page URL: https://x.test/page');
    expect(prompt).toContain('User agent: UA/1.0');
  });
});
