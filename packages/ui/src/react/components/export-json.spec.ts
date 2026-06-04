import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyJson, downloadJson, toPrettyJson } from './export-json.js';

describe('toPrettyJson', () => {
  it('pretty-prints with 2-space indentation', () => {
    const json = toPrettyJson({ a: 1, nested: { b: 2 } });
    expect(json).toBe('{\n  "a": 1,\n  "nested": {\n    "b": 2\n  }\n}');
  });

  it('falls back to String() for non-serializable values', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(toPrettyJson(cyclic)).toBe(String(cyclic));
  });
});

describe('copyJson', () => {
  const original = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });

  it('writes pretty JSON to the clipboard and resolves true', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    const result = await copyJson({ a: 1 });
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it('resolves false (does not throw) when clipboard is absent', async () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    await expect(copyJson({ a: 1 })).resolves.toBe(false);
  });

  it('resolves false when writeText rejects', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async () => {
            throw new Error('denied');
          },
        },
      },
      configurable: true,
    });
    await expect(copyJson({ a: 1 })).resolves.toBe(false);
  });
});

describe('downloadJson', () => {
  it('creates an anchor with the filename and clicks it', () => {
    // Use a real jsdom anchor so no casts are needed; jsdom click() is a no-op.
    const anchor = document.createElement('a');
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    const createObjectURL = vi.fn(() => 'blob:url');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    downloadJson('telescope-entry-e1.json', { a: 1 });

    expect(anchor.download).toBe('telescope-entry-e1.json');
    expect(anchor.getAttribute('href')).toBe('blob:url');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:url');

    createElement.mockRestore();
    vi.unstubAllGlobals();
  });
});
