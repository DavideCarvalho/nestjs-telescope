// packages/otel/src/propagation-api-only.sdk.spec.ts
import { isOtelPropagationActive } from '@dudousxd/nestjs-telescope';
import { metrics, propagation, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

/**
 * The real `@opentelemetry/api`, loaded and used but with no SDK registered: telescope must not
 * step aside (no propagator writes `traceparent`), or tracing across apps would send nothing.
 */
describe('tracing across apps with only @opentelemetry/api loaded', () => {
  it('does not treat the API alone as an active propagator', () => {
    expect(propagation.fields()).toEqual([]);
    trace.getTracer('x');
    metrics.getMeter('x');
    expect(isOtelPropagationActive()).toBe(false);
  });
});
