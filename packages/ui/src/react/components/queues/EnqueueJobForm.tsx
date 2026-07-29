import { type FormEvent, useState } from 'react';
import type { QueueCapabilities } from '../../../client/index.js';
import { Button } from '../../ui/index.js';
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
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-line p-3">
      <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">Send message</h3>
      <input
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Job name (optional)"
        aria-label="Job name"
        className="w-full rounded border border-line bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
      />
      <textarea
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        placeholder='{"to": "a@b.c"}'
        aria-label="Payload (JSON)"
        rows={4}
        className="w-full rounded border border-line bg-background px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground"
      />
      {jsonError && <p className="text-[10px] text-bad">{jsonError}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="good" disabled={mutation.isPending}>
          {mutation.isPending ? 'Sending…' : 'Send message'}
        </Button>
        {forbidden && <span className="text-[10px] text-bad">Not authorized</span>}
        {sentId !== undefined && !forbidden && (
          <span className="text-[10px] text-good">
            {sentId ? `Enqueued job ${sentId}` : 'Message enqueued'}
          </span>
        )}
      </div>
    </form>
  );
}
