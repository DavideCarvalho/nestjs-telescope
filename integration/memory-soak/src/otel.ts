// integration/memory-soak/src/otel.ts
//
// Optional OpenTelemetry NodeSDK exactly mirroring the incident's dev condition:
// @opentelemetry/instrumentation-http auto-instruments every inbound/outbound
// HTTP call, and a BatchSpanProcessor exports over OTLP-HTTP to a DEAD localhost
// port (4318 with nothing listening) so every export attempt ECONNREFUSEs.
//
// The SDK packages are heavy and may be absent; this module dynamic-imports them
// and degrades to a no-op when missing, so the harness still runs (the `no otel`
// cell is unaffected and a "full" run without the deps simply skips the SDK and
// says so). When present, this is the real leak candidate the incident calls out.

interface OtelHandle {
  shutdown(): Promise<void>;
  active: boolean;
}

const DEAD_OTLP_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';

interface NodeSdkLike {
  start(): void;
  shutdown(): Promise<void>;
}

interface NodeSdkModule {
  NodeSDK: new (config: unknown) => NodeSdkLike;
}

interface OtlpExporterModule {
  OTLPTraceExporter: new (config: { url: string }) => unknown;
}

interface HttpInstrumentationModule {
  HttpInstrumentation: new () => unknown;
}

async function loadOtelModules(): Promise<{
  sdk: NodeSdkModule;
  exporter: OtlpExporterModule;
  http: HttpInstrumentationModule;
} | null> {
  try {
    const [sdk, exporter, http] = await Promise.all([
      import('@opentelemetry/sdk-node') as Promise<NodeSdkModule>,
      import('@opentelemetry/exporter-trace-otlp-http') as Promise<OtlpExporterModule>,
      import('@opentelemetry/instrumentation-http') as Promise<HttpInstrumentationModule>,
    ]);
    return { sdk, exporter, http };
  } catch {
    return null;
  }
}

/**
 * Start a NodeSDK with HTTP auto-instrumentation exporting to a dead OTLP port.
 * Returns a handle; `active` is false (and shutdown a no-op) when the SDK deps
 * are not installed.
 */
export async function startOtel(): Promise<OtelHandle> {
  const modules = await loadOtelModules();
  if (modules === null) {
    return { active: false, shutdown: async () => {} };
  }
  const traceExporter = new modules.exporter.OTLPTraceExporter({ url: DEAD_OTLP_ENDPOINT });
  const sdk = new modules.sdk.NodeSDK({
    traceExporter,
    instrumentations: [new modules.http.HttpInstrumentation()],
  });
  sdk.start();
  return {
    active: true,
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch {
        // Shutdown of a never-reachable exporter can reject; ignore.
      }
    },
  };
}
