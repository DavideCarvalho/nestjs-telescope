import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { StatCard } from '../../react/components/extensions/stat-card.js';
import {
  type AiRunRow,
  type AiSpendRow,
  type AiStepTiming,
  type AiUnpricedRow,
  type AiUsageReport,
  StackedAreaChartCard,
  type StackedAreaRow,
  WindowSelect,
  relativeTime,
  useAi,
} from '../../react/index.js';
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../react/ui/index.js';

/**
 * Categorical hues for a run's time split. They encode DATA (which slice of the run), not state,
 * so they are not status tokens — see docs/AVIARY-UI.md, "Categorical data hues are not tokens".
 */
export const TIME_SLICE_COLORS = {
  queue: '#71717a',
  model: '#38bdf8',
  tools: '#2dd4bf',
} as const;

/** Who paid, as chart series: the app's users vs the platform itself. Categorical data hues. */
const SPEND_COLORS: Record<string, string> = { users: '#38bdf8', platform: '#c084fc' };

/** `$0.0123`, `$1.20`, `$1,234` — small amounts keep the digits that matter. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString('en-US');
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function actorLabel(key: string): string {
  return key === '@platform' ? 'Platform (@platform)' : key;
}

function SectionHeading({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <section className="space-y-3 rounded-lg border border-line bg-panel/40 p-4">
      {children}
    </section>
  );
}

/** A share of the window's spend as a thin bar plus the figure. */
function SpendTable({
  title,
  rows,
  total,
  label = (key) => key,
}: {
  title: string;
  rows: AiSpendRow[];
  total: number;
  label?: (key: string) => string;
}): JSX.Element {
  return (
    <Panel>
      <SectionHeading title={title} />
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing in this window.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-mono text-foreground" title={row.key}>
                  {label(row.key)}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {formatUsd(row.costUsd)}
                  <span className="ml-2 text-muted-foreground">
                    {formatCount(row.calls)} calls
                    {row.unpricedCalls > 0 ? ` · ${row.unpricedCalls} unpriced` : ''}
                  </span>
                </span>
              </div>
              <div className="h-1 rounded bg-line">
                <div
                  className="h-1 rounded bg-brand"
                  style={{ width: total > 0 ? `${Math.max(1, (row.costUsd / total) * 100)}%` : 0 }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Queue / model / tools as one stacked bar, scaled to `scaleMs` (the longest run on screen). */
export function TimeSplitBar({
  run,
  scaleMs,
}: {
  run: Pick<AiRunRow, 'queueMs' | 'modelMs' | 'toolsMs' | 'durationMs'>;
  scaleMs: number;
}): JSX.Element {
  const slices = [
    { key: 'queue', ms: run.queueMs ?? 0 },
    { key: 'model', ms: run.modelMs ?? 0 },
    { key: 'tools', ms: run.toolsMs ?? 0 },
  ] as const;
  const measured = slices.reduce((n, s) => n + s.ms, 0);
  if (measured === 0) {
    return <span className="text-[10px] text-muted-foreground">no breakdown</span>;
  }
  const scale = Math.max(scaleMs, measured, 1);
  return (
    <div
      className="flex h-2 w-40 overflow-hidden rounded bg-line"
      role="img"
      aria-label={`queue ${formatMs(run.queueMs)}, model ${formatMs(run.modelMs)}, tools ${formatMs(run.toolsMs)}`}
      title={`queue ${formatMs(run.queueMs)} · model ${formatMs(run.modelMs)} · tools ${formatMs(run.toolsMs)}`}
    >
      {slices.map((s) =>
        s.ms > 0 ? (
          <span
            key={s.key}
            style={{ width: `${(s.ms / scale) * 100}%`, background: TIME_SLICE_COLORS[s.key] }}
          />
        ) : null,
      )}
    </div>
  );
}

function TimeLegend(): JSX.Element {
  return (
    <span className="flex items-center gap-3 text-[10px] text-muted-foreground">
      {(Object.keys(TIME_SLICE_COLORS) as (keyof typeof TIME_SLICE_COLORS)[]).map((key) => (
        <span key={key} className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm" style={{ background: TIME_SLICE_COLORS[key] }} />
          {key}
        </span>
      ))}
    </span>
  );
}

function StatusBadge({ status, code }: { status: AiRunRow['status']; code: string | null }) {
  if (status === 'completed') return <Badge variant="good">completed</Badge>;
  if (status === 'cancelled') return <Badge variant="muted">cancelled</Badge>;
  return (
    <Badge variant="bad" title={code ?? undefined}>
      failed{code ? ` · ${code}` : ''}
    </Badge>
  );
}

function RunsTable({
  runs,
  selectedId,
  onSelect,
}: {
  runs: AiRunRow[];
  selectedId: string | null;
  onSelect: (run: AiRunRow) => void;
}): JSX.Element {
  const scaleMs = Math.max(
    1,
    ...runs.map((r) => (r.queueMs ?? 0) + (r.modelMs ?? 0) + (r.toolsMs ?? 0)),
  );
  return (
    <Table containerClassName="max-h-[28rem]">
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead>Queue · model · tools</TableHead>
          <TableHead className="text-right">Steps</TableHead>
          <TableHead className="text-right">Tool calls</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow
            key={run.entryId}
            onClick={() => onSelect(run)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(run);
              }
            }}
            tabIndex={0}
            aria-selected={selectedId === run.entryId}
            className={`cursor-pointer ${selectedId === run.entryId ? 'bg-panel-2' : 'hover:bg-panel'}`}
          >
            <TableCell className="whitespace-nowrap text-muted-foreground" title={run.at}>
              {relativeTime(new Date(run.at).getTime())}
            </TableCell>
            <TableCell className="font-mono">{run.agent}</TableCell>
            <TableCell>
              <StatusBadge status={run.status} code={run.code} />
            </TableCell>
            <TableCell className="max-w-[12rem] truncate font-mono text-muted-foreground">
              {run.modelId ?? '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatMs(run.durationMs)}</TableCell>
            <TableCell>
              <TimeSplitBar run={run} scaleMs={scaleMs} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{run.steps ?? '—'}</TableCell>
            <TableCell className="text-right tabular-nums">{run.toolCalls ?? '—'}</TableCell>
            <TableCell className="text-right tabular-nums">{formatUsd(run.costUsd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StepBar({ step, scaleMs }: { step: AiStepTiming; scaleMs: number }): JSX.Element {
  const scale = Math.max(1, scaleMs);
  return (
    <div className="flex h-2 w-56 overflow-hidden rounded bg-line" aria-hidden="true">
      {step.modelMs ? (
        <span
          style={{ width: `${(step.modelMs / scale) * 100}%`, background: TIME_SLICE_COLORS.model }}
        />
      ) : null}
      {step.toolsMs > 0 ? (
        <span
          style={{ width: `${(step.toolsMs / scale) * 100}%`, background: TIME_SLICE_COLORS.tools }}
        />
      ) : null}
    </div>
  );
}

/** The selected run: its numbers, its per-step breakdown, and links into the existing views. */
export function RunDetail({ run, onClose }: { run: AiRunRow; onClose: () => void }): JSX.Element {
  const scaleMs = Math.max(1, ...run.stepTimings.map((s) => (s.modelMs ?? 0) + s.toolsMs));
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run</h3>
          <span className="font-mono text-xs text-foreground">{run.runId ?? run.entryId}</span>
          <StatusBadge status={run.status} code={run.code} />
        </div>
        <div className="flex items-center gap-3 text-xs">
          {run.traceId ? (
            <Link
              className="text-brand hover:underline"
              to={`/traces/${encodeURIComponent(run.traceId)}`}
            >
              Open trace waterfall →
            </Link>
          ) : (
            <span className="text-muted-foreground">No trace recorded</span>
          )}
          <Link
            className="text-brand hover:underline"
            to={`/entries/view/${encodeURIComponent(run.entryId)}`}
          >
            Open entry →
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close run detail"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <StatCard label="Agent" value={run.agent} />
        <StatCard label="Duration" value={formatMs(run.durationMs)} accent="text-brand" />
        <StatCard label="Queue" value={formatMs(run.queueMs)} />
        <StatCard
          label="Model"
          value={formatMs(run.modelMs)}
          hint={`${run.modelCalls ?? '—'} calls`}
        />
        <StatCard
          label="Tools"
          value={formatMs(run.toolsMs)}
          hint={`${run.toolCalls ?? '—'} calls`}
        />
        <StatCard label="TTFT" value={formatMs(run.ttftMs)} />
        <StatCard
          label="Tokens"
          value={
            run.inputTokens === null ? '—' : formatCount(run.inputTokens + (run.outputTokens ?? 0))
          }
          {...(run.inputTokens === null
            ? {}
            : { hint: `${run.inputTokens} in · ${run.outputTokens ?? 0} out` })}
        />
        <StatCard
          label="Cost"
          value={formatUsd(run.costUsd)}
          {...(run.modelId === null ? {} : { hint: run.modelId })}
        />
      </div>
      {run.stepTimings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This run carried no per-step timings. They arrive with @dudousxd/nestjs-agent 1.38.0 (core
          0.60.0) and later.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead className="text-right">Model</TableHead>
              <TableHead className="text-right">Tools</TableHead>
              <TableHead>Model · tools</TableHead>
              <TableHead>Tool calls</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.stepTimings.map((step) => (
              <TableRow key={step.step}>
                <TableCell className="tabular-nums">#{step.step}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMs(step.modelMs)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMs(step.toolsMs)}</TableCell>
                <TableCell>
                  <StepBar step={step} scaleMs={scaleMs} />
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {step.tools.length === 0
                    ? '—'
                    : step.tools.map((t) => `${t.toolName} ${formatMs(t.ms)}`).join(' · ')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function RankList({
  title,
  runs,
  value,
  onSelect,
}: {
  title: string;
  runs: AiRunRow[];
  value: (run: AiRunRow) => string;
  onSelect: (run: AiRunRow) => void;
}): JSX.Element {
  return (
    <Panel>
      <SectionHeading title={title} />
      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing in this window.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {runs.map((run) => (
            <li key={run.entryId}>
              <button
                type="button"
                onClick={() => onSelect(run)}
                className="flex w-full items-center justify-between gap-3 py-1.5 text-left text-xs hover:bg-panel"
              >
                <span className="truncate font-mono text-foreground">
                  {run.agent}
                  <span className="ml-2 text-muted-foreground">{run.modelId ?? ''}</span>
                </span>
                <span className="shrink-0 tabular-nums text-foreground">{value(run)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function UnpricedTable({ rows }: { rows: AiUnpricedRow[] }): JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Feature</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Tokens in · out</TableHead>
          <TableHead className="text-right">Audio</TableHead>
          <TableHead>Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.feature}|${row.model}|${row.provider}`}>
            <TableCell className="font-mono">{row.feature}</TableCell>
            <TableCell className="font-mono text-muted-foreground">{row.model}</TableCell>
            <TableCell className="text-muted-foreground">{row.provider}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(row.calls)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCount(row.inputTokens)} · {formatCount(row.outputTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {row.audioSeconds > 0 ? `${Math.round(row.audioSeconds)}s` : '—'}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {relativeTime(new Date(row.lastAt).getTime())}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Spend over time, split by who pays: the platform vs the app's users. */
export function spendRows(report: AiUsageReport): StackedAreaRow[] {
  return report.spend.buckets.map((b) => ({
    label: new Date(b.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    users: Number((b.costUsd - b.platformUsd).toFixed(6)),
    platform: Number(b.platformUsd.toFixed(6)),
  }));
}

/**
 * The empty state. Two different claims, so two different messages: "nothing used AI in this
 * window" and "this app's agent lib does not publish the ledger event this screen reads".
 */
export function AiEmptyState({ report }: { report: AiUsageReport }): JSX.Element {
  if (report.coverage.legacyAgentLib) {
    return (
      <div className="rounded-md border border-dashed border-line px-4 py-6 text-sm text-muted-foreground">
        <p>
          <span className="text-warn">No AI spend recorded.</span> This window has{' '}
          {report.coverage.agentEvents} agent events but no <code>usage.recorded</code> — the app
          most likely runs an agent lib older than <code>@dudousxd/nestjs-agent</code> 1.38.0 (core
          0.60.0), which is the first to publish one event per usage-ledger row.
        </p>
        <p className="mt-2">
          Upgrade the agent packages to see spend, models and unpriced calls here.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-line px-4 py-6 text-sm text-muted-foreground">
      <p>No AI usage or agent runs in this window.</p>
      <p className="mt-2">
        This screen reads the <code>aviary:agent:*</code> events of{' '}
        <code>@dudousxd/nestjs-agent</code> 1.38.0+ (core 0.60.0+), recorded by its Telescope
        watcher (<code>@dudousxd/nestjs-agent-telescope</code>) or the generic diagnostics bridge (
        <code>@dudousxd/nestjs-diagnostics-telescope</code>). Widen the window, or check that one of
        them is registered.
      </p>
    </div>
  );
}

export function AiPage(): JSX.Element {
  const [window, setWindow] = useState('24h');
  const [params, setParams] = useSearchParams();
  const { data, isLoading, error } = useAi(window);
  const selectedId = params.get('run');

  const selected = useMemo(() => {
    if (!data || selectedId === null) return null;
    return (
      data.runs.find((r) => r.entryId === selectedId) ??
      data.slowest.find((r) => r.entryId === selectedId) ??
      data.mostExpensive.find((r) => r.entryId === selectedId) ??
      null
    );
  }, [data, selectedId]);

  const select = (run: AiRunRow | null) => {
    const next = new URLSearchParams(params);
    if (run === null) next.delete('run');
    else next.set('run', run.entryId);
    setParams(next, { replace: true });
  };

  const spend = data?.spend;
  const hasAny =
    data !== undefined && (data.coverage.usageEvents > 0 || data.coverage.runEvents > 0);

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-brand">AI</h2>
        <WindowSelect value={window} onChange={setWindow} />
      </div>

      {error ? (
        <p className="text-sm text-bad">Failed to load: {(error as Error).message}</p>
      ) : isLoading || !data || !spend ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !hasAny ? (
        <AiEmptyState report={data} />
      ) : (
        <>
          {data.coverage.legacyAgentLib && <AiEmptyState report={data} />}
          {data.truncated && (
            <p className="text-[11px] text-warn">
              Scanned {formatCount(data.scanned)} entries and hit the scan cap — older entries in
              this window are not counted.
            </p>
          )}

          {data.coverage.usageEvents > 0 && (
            <>
              <SectionHeading
                title="Spend"
                hint={`${formatCount(spend.calls)} calls in ${window}`}
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatCard
                  label="Total spend"
                  value={formatUsd(spend.totalUsd)}
                  accent="text-brand"
                />
                <StatCard
                  label="Platform share"
                  value={percent(spend.platformUsd, spend.totalUsd)}
                  hint={`${formatUsd(spend.platformUsd)} paid by @platform`}
                />
                <StatCard
                  label="Estimated share"
                  value={percent(spend.estimatedUsd, spend.totalUsd)}
                  hint={`${formatUsd(spend.estimatedUsd)} priced by estimate`}
                />
                <StatCard
                  label="Unpriced calls"
                  value={formatCount(spend.unpricedCalls)}
                  accent={spend.unpricedCalls > 0 ? 'text-warn' : 'text-foreground'}
                  hint="calls with no cost"
                />
                <StatCard
                  label="Tokens"
                  value={formatCount(spend.inputTokens + spend.outputTokens)}
                  hint={`${formatCount(spend.inputTokens)} in · ${formatCount(spend.outputTokens)} out · ${formatCount(spend.cacheReadTokens)} cached`}
                />
                <StatCard
                  label="Audio"
                  value={
                    spend.audioSeconds > 0 ? `${Math.round(spend.audioSeconds / 60)} min` : '—'
                  }
                  hint={`${Math.round(spend.audioSeconds)} s processed`}
                />
              </div>
              <StackedAreaChartCard
                title="Spend over time (USD) — users vs platform"
                series={['users', 'platform']}
                data={spendRows(data)}
                colors={SPEND_COLORS}
                brush={false}
              />
              <div className="grid gap-3 lg:grid-cols-3">
                <SpendTable title="By feature" rows={spend.byFeature} total={spend.totalUsd} />
                <SpendTable title="By model" rows={spend.byModel} total={spend.totalUsd} />
                <SpendTable
                  title="Top payers"
                  rows={spend.byActor}
                  total={spend.totalUsd}
                  label={actorLabel}
                />
              </div>
            </>
          )}

          {data.coverage.runEvents > 0 && (
            <>
              <SectionHeading
                title="Runs"
                hint={
                  data.coverage.runsWithoutTimings > 0
                    ? `${data.coverage.runsWithoutTimings} of ${data.coverage.runEvents} runs carried no timing breakdown`
                    : `${data.coverage.runEvents} runs`
                }
              />
              <div className="grid gap-3 lg:grid-cols-2">
                <RankList
                  title="Slowest"
                  runs={data.slowest}
                  value={(r) => formatMs(r.durationMs)}
                  onSelect={select}
                />
                <RankList
                  title="Most expensive"
                  runs={data.mostExpensive}
                  value={(r) => formatUsd(r.costUsd)}
                  onSelect={select}
                />
              </div>
              {selected && <RunDetail run={selected} onClose={() => select(null)} />}
              <Panel>
                <div className="flex items-center justify-between gap-3">
                  <SectionHeading title="Recent runs" hint="click a run for its steps" />
                  <TimeLegend />
                </div>
                <RunsTable runs={data.runs} selectedId={selectedId} onSelect={select} />
              </Panel>
            </>
          )}

          {data.coverage.usageEvents > 0 && (
            <Panel>
              <SectionHeading
                title="Unpriced"
                hint="calls the ledger recorded with no cost — give them a price or a provider cost"
              />
              {data.unpriced.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Every call in this window was priced.
                </p>
              ) : (
                <UnpricedTable rows={data.unpriced} />
              )}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
