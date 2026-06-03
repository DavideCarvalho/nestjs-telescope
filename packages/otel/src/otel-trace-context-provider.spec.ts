import {
  type Context,
  type ContextManager,
  ROOT_CONTEXT,
  context,
  trace,
} from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtelTraceContextProvider } from './otel-trace-context-provider.js';

/**
 * Minimal synchronous context manager so `trace.getActiveSpan()` actually sees
 * the span set by `context.with`. The default API ships a no-op manager that
 * never propagates context, which would make every read return null. Our
 * `withSpan` helper runs fully synchronously, so a simple active-context swap
 * (restored in a finally) is sufficient and keeps the test dependency-light.
 */
class SyncContextManager implements ContextManager {
  private activeContext: Context = ROOT_CONTEXT;

  active(): Context {
    return this.activeContext;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.activeContext;
    this.activeContext = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.activeContext = previous;
    }
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.activeContext = ROOT_CONTEXT;
    return this;
  }
}

const contextManager = new SyncContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager);
});

afterAll(() => {
  contextManager.disable();
});

function withSpan<T>(traceId: string, spanId: string, fn: () => T): T {
  const spanContext = { traceId, spanId, traceFlags: 1, isRemote: false };
  return context.with(trace.setSpanContext(ROOT_CONTEXT, spanContext), fn);
}

describe('OtelTraceContextProvider', () => {
  const provider = new OtelTraceContextProvider();
  it('returns the active span ids', () => {
    withSpan('a'.repeat(32), 'b'.repeat(16), () => {
      expect(provider.current()).toEqual({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    });
  });
  it('returns null when no span is active', () => {
    expect(provider.current()).toBeNull();
  });
  it('returns null for an invalid (all-zero) span context', () => {
    withSpan('0'.repeat(32), '0'.repeat(16), () => {
      expect(provider.current()).toBeNull();
    });
  });
});
