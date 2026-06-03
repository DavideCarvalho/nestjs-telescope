import type { QueueState } from '../../../client/index.js';

export const QUEUE_STATE_ORDER: readonly QueueState[] = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
];

/** Per-state accent colors, consistent across list badges and tabs. */
export const STATE_ACCENT: Record<QueueState, string> = {
  waiting: 'text-zinc-300',
  active: 'text-sky-400',
  delayed: 'text-amber-400',
  failed: 'text-red-400',
  completed: 'text-emerald-400',
  paused: 'text-violet-400',
};

export function relativeTime(timestamp: number | null): string {
  if (timestamp == null) return '—';
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 0) return 'just now';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** One-line, length-capped JSON-ish preview of a job payload. */
export function payloadPreview(data: unknown, max = 80): string {
  if (data === undefined || data === null) return '—';
  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    text = String(data);
  }
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
