import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals: false` means testing-library's auto-cleanup is not registered;
// unmount the DOM between tests so repeated renders don't leak into each other.
afterEach(() => {
  cleanup();
});

// `findBy*`/`waitFor` give up after 1s by default. Some components only settle after a debounce
// plus a query round-trip (the tag autocomplete waits 200ms, then fetches), which takes ~250ms on a
// laptop but can exceed 1s on a CI runner executing every spec file in parallel. A wait that never
// settles still fails, with its own error before vitest's 5s test timeout; a slow runner no longer does.
configure({ asyncUtilTimeout: 4000 });

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
