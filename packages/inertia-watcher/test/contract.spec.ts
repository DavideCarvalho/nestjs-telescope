// packages/inertia-watcher/test/contract.spec.ts
//
// Cross-repo wire contract test. `test/fixtures/inertia-render.v1.json` is the
// canonical `v: 1` payload published on the `nestjs-inertia:render` diagnostics
// channel. THE PRODUCER REPO (`@dudousxd/nestjs-inertia`) COMMITS A BYTE-IDENTICAL
// COPY OF THIS FILE — if you touch one, touch both. It must stay byte-identical so
// both sides can prove they agree on the shape without importing each other.
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildInertiaContent, isInertiaDiagnostic } from '../src/inertia-content.js';

const fixtureUrl = new URL('./fixtures/inertia-render.v1.json', import.meta.url);
const sample = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')) as Record<
  string,
  unknown
>;

describe('inertia-render wire contract', () => {
  it('accepts the committed v1 fixture', () => {
    expect(isInertiaDiagnostic(sample)).toBe(true);
  });

  it('maps the v1 fixture without throwing', () => {
    expect(() =>
      buildInertiaContent(sample as Parameters<typeof buildInertiaContent>[0]),
    ).not.toThrow();
    const input = buildInertiaContent(sample as Parameters<typeof buildInertiaContent>[0]);
    expect(input.type).toBe('inertia');
    expect(input.familyHash).toBe('inertia:Dashboard');
  });

  it('rejects a payload with an unsupported version (v: 2)', () => {
    expect(isInertiaDiagnostic({ ...sample, v: 2 })).toBe(false);
  });
});
