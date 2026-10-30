---
"@dudousxd/nestjs-telescope": minor
"@dudousxd/nestjs-telescope-ui": minor
"@dudousxd/nestjs-telescope-otel": minor
---

AI usage and agent run timings are first-class.

- **AI screen** (`#/ai`): spend over the window (total, platform and estimated shares, by feature, model and top payers, over time), agent runs with a queue / model / tools bar, steps, tool calls, cost, model and status, the slowest and most expensive runs, a per-step breakdown with links to the trace waterfall, and the calls nobody priced. Backed by `GET <path>/api/ai`, summarized from the `aviary:agent:*` entries `@dudousxd/nestjs-agent` 1.38.0+ (core 0.60.0+) records. An app on an older agent lib gets an empty state that says so.
- **Metrics** `aviary_ai_cost_usd_total`, `aviary_ai_tokens_total`, `aviary_ai_audio_seconds_total`, `aviary_ai_requests_total` (counters, as Prometheus names them) and `aviary_agent_run_duration_ms`, `aviary_agent_run_queue_ms`, `aviary_agent_run_model_ms`, `aviary_agent_run_tools_ms`, `aviary_agent_tool_duration_ms` (histograms), read straight from the diagnostics channels. No actor, run or thread attributes.
- `aiMetrics: { prometheus: true }` serves them at `GET <path>/api/metrics` (Prometheus text format) behind the API gate. Off by default.
- `TelescopeAiMetricsExporter` (`-otel`) pushes them over OTLP/HTTP from a private `MeterProvider`, with its own endpoint. `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http` and `@opentelemetry/resources` are optional, lazily loaded peers.
- An importable Grafana dashboard ships at `@dudousxd/nestjs-telescope-otel/grafana/aviary-ai-dashboard.json`.
- `StackedAreaChartCard` takes an optional `colors` map.
