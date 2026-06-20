import type { Entry } from '@dudousxd/nestjs-telescope';

export interface SpanShape {
  name: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number>;
  traceId: string | null;
  spanId: string | null;
}

/** Pure: a recorded Entry -> the shape of the span it should produce. */
export function entryToSpan(entry: Entry): SpanShape {
  const startMs = entry.createdAt.getTime();
  const endMs = startMs + (entry.durationMs ?? 0);
  const attributes: Record<string, string | number> = {
    'telescope.type': entry.type,
    'telescope.batch_id': entry.batchId,
  };
  if (entry.durationMs !== null) attributes['telescope.duration_ms'] = entry.durationMs;
  for (const tag of entry.tags) attributes[`telescope.tag.${tag}`] = 1;
  return { name: `telescope.${entry.type}`, startMs, endMs, attributes, traceId: entry.traceId, spanId: entry.spanId };
}
