import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals: false` means testing-library's auto-cleanup is not registered;
// unmount the DOM between tests so repeated renders don't leak into each other.
afterEach(() => {
  cleanup();
});

// jsdom lacks ResizeObserver, which Recharts' ResponsiveContainer needs on mount.
// A no-op stub lets the cards render (still 0x0, so charts stay empty in tests).
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
