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

## License

MIT © Davi Carvalho
