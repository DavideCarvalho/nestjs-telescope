# @dudousxd/nestjs-telescope-otel

OpenTelemetry trace-context provider for
[`@dudousxd/nestjs-telescope`](../../README.md). Implements core's
`TraceContextProvider` SPI by reading the **active** OpenTelemetry span via
[`@opentelemetry/api`](https://www.npmjs.com/package/@opentelemetry/api), so each
recorded Telescope entry is stamped with the ambient `traceId`/`spanId`.

This package is **read-only**: it reads whatever span is already active in the
caller's context. It does **not** create, sample, or export spans — your
existing OpenTelemetry SDK / instrumentation owns that.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-otel
```

`@opentelemetry/api` is an optional peer. When it (or an active span) is absent,
the provider returns `null` and recording proceeds without a trace link — it
never throws.

## Usage

Register the provider as `traceContext` on the module. Combine it with a
`traceLink` template to deep-link each entry to your trace backend (the
`{traceId}` placeholder is substituted at render time):

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { OtelTraceContextProvider } from '@dudousxd/nestjs-telescope-otel';

@Module({
  imports: [
    TelescopeModule.forRoot({
      traceContext: new OtelTraceContextProvider(),
      traceLink: 'https://grafana.example.com/explore?traceId={traceId}',
    }),
  ],
})
export class AppModule {}
```

Every entry recorded inside an active span then carries:

```ts
{
  traceId: string; // lower-case hex, from the active span context
  spanId: string;
}
```

## Exporting metrics + traces (OUT)

`OtelTraceContextProvider` reads trace context IN. `TelescopeOtelExporter`
pushes everything Telescope records OUT — **complete** metrics (pre-sampling) and
**sampled** spans (post-flush).

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import {
  OtelTraceContextProvider,
  TelescopeOtelExporter,
  TelescopeOtelMetricsModule,
} from '@dudousxd/nestjs-telescope-otel';

// One instance, registered in two places.
const otel = new TelescopeOtelExporter();

@Module({
  imports: [
    TelescopeModule.forRoot({
      traceContext: new OtelTraceContextProvider(), // IN
      extensions: [otel],                           // OUT (metrics + spans)
    }),
    TelescopeOtelMetricsModule.forExporter(otel),   // GET /metrics (Prometheus)
  ],
})
export class AppModule {}
```

- **Metrics** are mirrored into the OTel Meter (OTLP push when your app has an
  OTel SDK) AND exposed as a dependency-free Prometheus scrape at `/metrics`.
- **Spans** go through the OTel Tracer; point your SDK's OTLP exporter at Tempo/
  Jaeger. Without an OTel SDK, both degrade to no-op — the Prometheus scrape still
  works.
- **Durations** export as real Prometheus **histograms** (`_bucket{le}` + `_sum`/
  `_count`), so `histogram_quantile(0.95, ...)` works in Grafana. Default bucket
  bounds (ms): `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000` — the same
  boundaries feed the OTLP histogram so push and scrape agree.
- **Cardinality is bounded.** Each metric keeps at most `maxSeriesPerMetric`
  (default 2000) distinct label-series; beyond that, new label combinations are
  dropped (existing series keep counting — counters never reset) and surfaced as
  `telescope_metrics_dropped_series_total{metric}` so the loss is visible in the
  scrape rather than a silent memory leak. Keep high-cardinality labels (e.g.
  outbound `host`, exception `class`) in mind when sizing this.

## License

MIT © Davi Carvalho
