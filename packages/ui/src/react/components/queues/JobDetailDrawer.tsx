import type { QueueCapabilities, QueueJobDetail, QueueState } from '../../../client/index.js';
import { Badge, Button, Dialog, DialogContent, DialogTitle } from '../../ui/index.js';
import { useQueueJob } from '../../use-telescope-queries.js';
import { JobActions } from './JobActions.js';
import { relativeTime } from './queue-format.js';

function prettyJson(value: unknown): string {
  if (value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonBlock({ label, value }: { label: string; value: unknown }): JSX.Element {
  return (
    <section>
      <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</h4>
      <pre className="overflow-auto rounded bg-background p-2.5 text-[11px] leading-relaxed text-foreground ring-1 ring-line">
        {prettyJson(value)}
      </pre>
    </section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line-soft py-1 first:border-0">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function timestampLabel(value: number | null): string {
  if (value == null) return '—';
  return `${new Date(value).toLocaleString()} (${relativeTime(value)})`;
}

function DetailBody({
  detail,
  capabilities,
  driver,
  queue,
  state,
  onClose,
}: {
  detail: QueueJobDetail;
  capabilities: QueueCapabilities | undefined;
  driver: string;
  queue: string;
  state: QueueState;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-brand">{detail.name || 'job'}</span>
          <Badge className="capitalize">{detail.state}</Badge>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">{detail.id}</div>
      </header>

      <JobActions
        capabilities={capabilities}
        driver={driver}
        queue={queue}
        id={detail.id}
        state={state}
        onDone={onClose}
      />

      <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs">
        <MetaRow
          label="Attempts"
          value={
            detail.maxAttempts != null
              ? `${detail.attemptsMade}/${detail.maxAttempts}`
              : `${detail.attemptsMade}`
          }
        />
        <MetaRow label="Progress" value={detail.progress != null ? `${detail.progress}` : '—'} />
        <MetaRow label="Created" value={timestampLabel(detail.timestamp)} />
        <MetaRow label="Processed" value={timestampLabel(detail.processedOn)} />
        <MetaRow label="Finished" value={timestampLabel(detail.finishedOn)} />
      </div>

      {detail.failedReason && (
        <section>
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-bad">Failed reason</h4>
          <p className="tint-bad rounded border px-2.5 py-2 text-[11px]">{detail.failedReason}</p>
        </section>
      )}

      <JsonBlock label="Payload (data)" value={detail.data} />
      <JsonBlock label="Options (opts)" value={detail.opts} />
      {detail.returnValue !== undefined && detail.returnValue !== null && (
        <JsonBlock label="Return value" value={detail.returnValue} />
      )}

      {detail.stacktrace && detail.stacktrace.length > 0 && (
        <section>
          <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Stacktrace
          </h4>
          <pre className="overflow-auto rounded bg-background p-2.5 text-[11px] leading-relaxed text-bad ring-1 ring-line">
            {detail.stacktrace.join('\n')}
          </pre>
        </section>
      )}
    </div>
  );
}

/** Right slide-over showing a single job's full detail + actions. */
export function JobDetailDrawer({
  driver,
  queue,
  jobId,
  state,
  capabilities,
  onClose,
}: {
  driver: string;
  queue: string;
  jobId: string;
  state: QueueState;
  capabilities: QueueCapabilities | undefined;
  onClose: () => void;
}): JSX.Element {
  const { data, isLoading, isError } = useQueueJob(driver, queue, jobId);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent placement="right" className="flex flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <DialogTitle className="text-xs font-normal uppercase tracking-wide text-muted-foreground">
            Job detail
          </DialogTitle>
          <Button variant="ghost" size="xs" aria-label="Close job detail" onClick={onClose}>
            ✕
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading job…</p>
          ) : isError ? (
            <p className="text-xs text-bad">Failed to load job.</p>
          ) : !data ? (
            <p className="text-xs text-muted-foreground">
              Job not found (it may have been removed).
            </p>
          ) : (
            <DetailBody
              detail={data}
              capabilities={capabilities}
              driver={driver}
              queue={queue}
              state={state}
              onClose={onClose}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
