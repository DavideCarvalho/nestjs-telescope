import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

export interface MetricSample {
  counter: string;
  labels: Record<string, string>;
  durationMs: number | null;
  /** When set, also feed `durationMs` into this histogram/summary. */
  durationMetric?: string;
}

/** Pure: RecordInput -> the metric it contributes, or null if not exported. */
export function mapInput(input: RecordInput): MetricSample | null {
  const c = (input.content ?? {}) as Record<string, unknown>;
  const dur = input.durationMs ?? null;
  switch (input.type) {
    case EntryType.Request:
      return {
        counter: 'telescope_requests_total',
        labels: { method: String(c['method'] ?? ''), status: String(c['statusCode'] ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_request_duration_ms',
      };
    case EntryType.Query:
      return {
        counter: 'telescope_queries_total',
        labels: { db: String(c['connection'] ?? c['db'] ?? 'default') },
        durationMs: dur,
        durationMetric: 'telescope_query_duration_ms',
      };
    case EntryType.Job:
      return {
        counter: 'telescope_jobs_total',
        labels: { status: String(c['status'] ?? (c['failed'] ? 'failed' : 'completed')) },
        durationMs: dur,
        durationMetric: 'telescope_job_duration_ms',
      };
    case EntryType.Exception:
    case EntryType.ClientException:
      return {
        counter: 'telescope_exceptions_total',
        labels: { class: String(c['class'] ?? c['name'] ?? 'Error') },
        durationMs: null,
      };
    case EntryType.Cache:
      return {
        counter: 'telescope_cache_total',
        labels: { result: c['hit'] === true ? 'hit' : c['hit'] === false ? 'miss' : 'write' },
        durationMs: null,
      };
    case EntryType.HttpClient:
      return {
        counter: 'telescope_http_client_total',
        labels: { host: String(c['host'] ?? ''), status: String(c['statusCode'] ?? '') },
        durationMs: dur,
        durationMetric: 'telescope_http_client_duration_ms',
      };
    case 'diagnostic':
      return {
        counter: 'telescope_diagnostic_total',
        labels: { lib: String(c['lib'] ?? ''), event: String(c['event'] ?? '') },
        durationMs: null,
      };
    default:
      return null;
  }
}

interface CounterCell { count: number; durSum: number; durCount: number; durMetric?: string }

/** Dependency-free internal aggregation for the Prometheus `/metrics` scrape. */
export class MetricStore {
  private readonly cells = new Map<string, { sample: MetricSample; cell: CounterCell }>();

  add(sample: MetricSample): void {
    const key = `${sample.counter}|${serializeLabels(sample.labels)}`;
    let entry = this.cells.get(key);
    if (entry === undefined) {
      const cell: CounterCell = { count: 0, durSum: 0, durCount: 0 };
      if (sample.durationMetric !== undefined) cell.durMetric = sample.durationMetric;
      entry = { sample, cell };
      this.cells.set(key, entry);
    }
    entry.cell.count += 1;
    if (sample.durationMs !== null && sample.durationMetric) {
      entry.cell.durSum += sample.durationMs;
      entry.cell.durCount += 1;
    }
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const { sample, cell } of this.cells.values()) {
      const labels = serializeLabels(sample.labels);
      lines.push(`${sample.counter}${labels} ${cell.count}`);
      if (cell.durMetric && cell.durCount > 0) {
        lines.push(`${cell.durMetric}_sum${labels} ${cell.durSum}`);
        lines.push(`${cell.durMetric}_count${labels} ${cell.durCount}`);
      }
    }
    return lines.join('\n') + (lines.length ? '\n' : '');
  }
}

function serializeLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}
