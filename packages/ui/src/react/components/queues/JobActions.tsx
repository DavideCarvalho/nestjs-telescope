import { useState } from 'react';
import type {
  JobActionName,
  QueueActionName,
  QueueCapabilities,
  QueueState,
} from '../../../client/index.js';
import { Button, type ButtonProps } from '../../ui/index.js';
import { useQueueAction, useQueueJobAction } from '../../use-telescope-queries.js';

/** Does the driver advertise this action AND are mutations enabled at all? */
export function supportsAction(
  capabilities: QueueCapabilities | undefined,
  driver: string,
  action: QueueActionName,
): boolean {
  if (!capabilities?.mutationsEnabled) return false;
  return (capabilities.actionsByDriver[driver] ?? []).includes(action);
}

/**
 * Which per-job actions are valid for a job in the given state.
 * - promote only for a delayed job
 * - retry only for failed/completed jobs
 * - remove whenever supported
 */
export function jobActionAllowedForState(action: JobActionName, state: QueueState): boolean {
  switch (action) {
    case 'promote':
      return state === 'delayed';
    case 'retry':
      return state === 'failed' || state === 'completed';
    case 'remove':
      return true;
    default:
      return false;
  }
}

function isForbidden(error: unknown): boolean {
  return error instanceof Error && /\b403\b/.test(error.message);
}

/** Semantic `Button` variant per action — the hue comes from the Aviary status tokens. */
const ACTION_VARIANT: Record<JobActionName, NonNullable<ButtonProps['variant']>> = {
  retry: 'good',
  promote: 'warn',
  remove: 'bad',
};

function JobActionButton({
  driver,
  queue,
  id,
  action,
  onDone,
}: {
  driver: string;
  queue: string;
  id: string;
  action: JobActionName;
  onDone: (() => void) | undefined;
}): JSX.Element {
  const mutation = useQueueJobAction();
  const [confirming, setConfirming] = useState(false);
  const pending = mutation.isPending;
  const forbidden = isForbidden(mutation.error);

  async function fire(): Promise<void> {
    setConfirming(false);
    try {
      await mutation.mutateAsync({ driver, queue, id, action });
      onDone?.();
    } catch {
      // surfaced inline via mutation.error
    }
  }

  if (action === 'remove' && confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button variant="bad" disabled={pending} onClick={fire}>
          {pending ? 'Removing…' : 'Confirm remove'}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col">
      <Button
        variant={ACTION_VARIANT[action]}
        disabled={pending}
        onClick={action === 'remove' ? () => setConfirming(true) : fire}
        className="capitalize"
      >
        {pending ? `${action}…` : action}
      </Button>
      {forbidden && <span className="mt-0.5 text-[10px] text-bad">Not authorized</span>}
    </span>
  );
}

/** Per-job action buttons, gated by capabilities + job state. */
export function JobActions({
  capabilities,
  driver,
  queue,
  id,
  state,
  onDone,
}: {
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
  id: string;
  state: QueueState;
  onDone?: () => void;
}): JSX.Element | null {
  const actions: JobActionName[] = (['retry', 'promote', 'remove'] as const).filter(
    (action) =>
      supportsAction(capabilities, driver, action) && jobActionAllowedForState(action, state),
  );
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {actions.map((action) => (
        <JobActionButton
          key={action}
          driver={driver}
          queue={queue}
          id={id}
          action={action}
          onDone={onDone}
        />
      ))}
    </div>
  );
}

/** "Retry all failed" bulk action, gated by capabilities; shown on the failed tab. */
export function RetryAllFailedButton({
  capabilities,
  driver,
  queue,
}: {
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
}): JSX.Element | null {
  const mutation = useQueueAction();
  if (!supportsAction(capabilities, driver, 'retry-all')) return null;
  const forbidden = isForbidden(mutation.error);

  async function fire(): Promise<void> {
    try {
      await mutation.mutateAsync({ driver, queue, action: 'retry-all', state: 'failed' });
    } catch {
      // surfaced inline via mutation.error
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="good" disabled={mutation.isPending} onClick={fire}>
        {mutation.isPending ? 'Retrying all…' : 'Retry all failed'}
      </Button>
      {forbidden && <span className="text-[10px] text-bad">Not authorized</span>}
    </span>
  );
}

/**
 * "Redrive DLQ" action for SQS-style drivers (moves dead-lettered messages back
 * to the source queue via the native message-move task). Shown on the failed tab,
 * gated by capabilities — only when the driver advertises `'redrive'` and
 * mutations are enabled. Confirms before firing (it moves messages); a 403
 * surfaces inline as "Not authorized".
 */
export function RedriveDlqButton({
  capabilities,
  driver,
  queue,
}: {
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
}): JSX.Element | null {
  const mutation = useQueueAction();
  const [confirming, setConfirming] = useState(false);
  if (!supportsAction(capabilities, driver, 'redrive')) return null;
  const forbidden = isForbidden(mutation.error);

  async function fire(): Promise<void> {
    setConfirming(false);
    try {
      await mutation.mutateAsync({ driver, queue, action: 'redrive' });
    } catch {
      // surfaced inline via mutation.error
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button variant="warn" disabled={mutation.isPending} onClick={fire}>
          {mutation.isPending ? 'Redriving…' : 'Confirm redrive'}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="warn" disabled={mutation.isPending} onClick={() => setConfirming(true)}>
        Redrive DLQ
      </Button>
      {forbidden && <span className="text-[10px] text-bad">Not authorized</span>}
    </span>
  );
}
