export interface Entry {
  id: string;
  batchId: string;
  type: string;
  familyHash: string | null;
  content: unknown;
  tags: string[];
  sequence: number;
  durationMs: number | null;
  origin: string;
  instanceId: string;
  createdAt: string;
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export interface EntryWithBatch extends Entry {
  batch: Entry[];
}
export interface EntriesQuery {
  type?: string;
  tag?: string;
  batchId?: string;
  familyHash?: string;
  cursor?: string;
  limit?: number;
}
export interface TelescopeMeta {
  enabled: boolean;
  droppedCount: number;
  watchers: string[];
}
export type PulseReport = Record<string, unknown>;
export type QueueMetricsReport = Record<string, unknown>;
