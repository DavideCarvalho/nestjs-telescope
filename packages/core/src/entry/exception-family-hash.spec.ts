// packages/core/src/entry/exception-family-hash.spec.ts
import { describe, expect, it } from 'vitest';
import { exceptionFamilyHash } from './exception-family-hash.js';

describe('exceptionFamilyHash', () => {
  it('combines name, message, and the top stack frame', () => {
    const hash = exceptionFamilyHash({
      name: 'TypeError',
      message: 'x is undefined',
      stack: 'TypeError: x is undefined\n    at foo (app.js:1:1)\n    at bar (app.js:2:2)',
    });
    expect(hash).toBe('TypeError:x is undefined:at foo (app.js:1:1)');
  });

  it('skips the leading Error: message header line and uses the first frame', () => {
    const hash = exceptionFamilyHash({
      name: 'Error',
      message: 'boom',
      stack: 'Error: boom\n    at handler (server.js:10:5)',
    });
    expect(hash).toBe('Error:boom:at handler (server.js:10:5)');
  });

  it('supports the browser @-form frame (Firefox/Safari)', () => {
    const hash = exceptionFamilyHash({
      name: 'TypeError',
      message: 'oops',
      stack: 'oops\nrender@https://app/bundle.js:5:10\nmount@https://app/bundle.js:6:1',
    });
    expect(hash).toBe('TypeError:oops:render@https://app/bundle.js:5:10');
  });

  it('degrades to name:message: when no stack/frame is present', () => {
    expect(exceptionFamilyHash({ name: 'TypeError', message: 'boom', stack: null })).toBe(
      'TypeError:boom:',
    );
    expect(
      exceptionFamilyHash({ name: 'TypeError', message: 'boom', stack: 'just a header' }),
    ).toBe('TypeError:boom:');
  });

  it('keeps the SAME bug grouped and DIFFERENT call sites separate', () => {
    const callSiteA = 'TypeError: nope\n    at a (a.js:1:1)';
    const callSiteB = 'TypeError: nope\n    at b (b.js:9:9)';
    const a1 = exceptionFamilyHash({ name: 'TypeError', message: 'nope', stack: callSiteA });
    const a2 = exceptionFamilyHash({ name: 'TypeError', message: 'nope', stack: callSiteA });
    const b = exceptionFamilyHash({ name: 'TypeError', message: 'nope', stack: callSiteB });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
