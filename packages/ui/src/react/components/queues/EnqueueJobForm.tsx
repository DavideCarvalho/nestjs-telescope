import { type FormEvent, useState } from 'react';
import type { QueueCapabilities } from '../../../client/index.js';
import { useQueueEnqueue } from '../../use-telescope-queries.js';
import { supportsAction } from './JobActions.js';

function isForbidden(error: unknown): boolean {
  return error instanceof Error && /\b403\b/.test(error.message);
}

/** Parse the JSON payload; returns either the value or a message describing why it failed. */
function parsePayload(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, message: 'Payload is required.' };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, message: 'Payload must be valid JSON.' };
  }
}

/**
 * "Send message" form for enqueueing a new job onto the selected queue. Shown
 * only when the driver advertises the `'enqueue'` capability AND mutations are
 * enabled (default-deny gate on the server). The payload is parsed as JSON;
 * invalid JSON surfaces inline without calling the API. A 403 surfaces inline
 * as "Not authorized".
 */
export function EnqueueJobForm({
  capabilities,
  driver,
  queue,
}: {
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
}): JSX.Element | null {
  const mutation = useQueueEnqueue();
  const [name, setName] = useState('');
  const [payload, setPayload] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null | undefined>(undefined);

  if (!supportsAction(capabilities, driver, 'enqueue')) return null;
  const forbidden = isForbidden(mutation.error);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSentId(undefined);
    const parsed = parsePayload(payload);
    if (!parsed.ok) {
      setJsonError(parsed.message);
      return;
    }
    setJsonError(null);
    try {
      const result = await mutation.mutateAsync({
        driver,
        queue,
        ...(name.trim() !== '' ? { name: name.trim() } : {}),
        payload: parsed.value,
      });
      setSentId(result.id);
      setPayload('');
    } catch {
      // surfaced inline via mutation.error
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-zinc-800 p-3">
      <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">Send message</h3>
      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Job name (optional)"
        aria-label="Job name"
        className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
      />
      <textarea
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        placeholder='{"to": "a@b.c"}'
        aria-label="Payload (JSON)"
        rows={4}
        className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
      />
      {jsonError && <p className="text-[10px] text-red-400">{jsonError}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded border border-emerald-500/40 px-2.5 py-1 text-[11px] text-emerald-300 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
        >
          {mutation.isPending ? 'Sending…' : 'Send message'}
        </button>
        {forbidden && <span className="text-[10px] text-red-400">Not authorized</span>}
        {sentId !== undefined && !forbidden && (
          <span className="text-[10px] text-emerald-400">
            {sentId ? `Enqueued job ${sentId}` : 'Message enqueued'}
          </span>
        )}
      </div>
    </form>
  );
}
