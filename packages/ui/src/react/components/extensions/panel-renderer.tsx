import type { JSX } from 'react';
import type { Panel } from '../../../client/types.js';
import { Button } from '../../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table.js';
import { AreaChartCard } from '../charts/area-chart-card.js';
import { BarChartCard } from '../charts/bar-chart-card.js';
import { BreakdownCard } from '../charts/breakdown-card.js';
import { DistributionChartCard } from '../charts/distribution-chart-card.js';
import { GaugeCard } from '../charts/gauge-card.js';
import { StackedAreaChartCard } from '../charts/stacked-area-chart-card.js';
import { StatCard } from './stat-card.js';

/** The `table` panel variant's column shape, pulled from the discriminated union
 *  rather than re-declared, so it can never drift from `Panel`. */
type TableColumn = Extract<Panel, { kind: 'table' }>['columns'][number];

function formatStat(value: number, format?: 'number' | 'percent' | 'duration' | 'rate'): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  if (format === 'rate') return `${new Intl.NumberFormat().format(Math.round(value))}/hr`;
  return new Intl.NumberFormat().format(value);
}

function fillTemplate(href: string, row: Record<string, unknown>): string {
  const filled = href.replace(/\{(\w+)\}/g, (_m, k: string) => String(row[k] ?? ''));
  // The template is author-controlled but the substituted values come from provider
  // row data — never let a row turn the link into a `javascript:`/`data:` URL.
  if (/^\s*(javascript|data|vbscript):/i.test(filled)) return '#';
  return filled;
}

/** Shared empty-state card so a provider that resolves with no rows reads as
 *  "nothing happened in this window" rather than a blank/broken panel. */
function EmptyPanel({ title }: { title: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-panel/40">
      <p className="border-b border-line px-4 py-2 text-xs font-medium text-foreground">{title}</p>
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">No data in this window.</p>
    </div>
  );
}

/** Shared `<tbody>` rows for a table panel — identical for the paged and
 *  non-paged variants, so factoring it out doesn't change either's markup. */
function PanelRows({
  columns,
  rows,
}: {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
}): JSX.Element {
  return (
    <TableBody>
      {rows.length === 0 ? (
        <TableRow>
          <TableCell colSpan={columns.length} className="py-6 text-center text-muted-foreground">
            No data in this window.
          </TableCell>
        </TableRow>
      ) : null}
      {rows.map((row) => (
        <TableRow key={columns.map((c) => String(row[c.key] ?? '')).join('|')}>
          {columns.map((c) => {
            const text = String(row[c.key] ?? '');
            return (
              // Cells stay on one line: wrapping is what turned durable's "Workers"
              // panel into three-line rows. Anything wider than the card is reachable
              // by scrolling the table now, which is the cheaper trade of the two.
              <TableCell key={c.key} className="whitespace-nowrap text-foreground">
                {c.link ? (
                  <a
                    className="text-sky-400 hover:underline"
                    href={fillTemplate(c.link.href, row)}
                    {...(c.link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                  >
                    {text}
                  </a>
                ) : (
                  text
                )}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </TableBody>
  );
}

/** `<thead>` shared by both table variants. */
function PanelHead({ columns }: { columns: TableColumn[] }): JSX.Element {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((c) => (
          <TableHead key={c.key} className="whitespace-nowrap">
            {c.label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

/**
 * Prev/next + "page X of Y" controls for a paged table panel. Purely
 * presentational — the caller (the dashboard's `BoundPanel`) owns the actual
 * page state and re-resolves the provider; this just reports intent.
 */
function PagerControls({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange?: (page: number) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
      <Button
        variant="outline"
        size="xs"
        disabled={page <= 1}
        onClick={() => onPageChange?.(page - 1)}
        className="px-1.5 text-muted-foreground"
      >
        Prev
      </Button>
      <span>
        Page {page} of {totalPages}
      </span>
      <Button
        variant="outline"
        size="xs"
        disabled={page >= totalPages}
        onClick={() => onPageChange?.(page + 1)}
        className="px-1.5 text-muted-foreground"
      >
        Next
      </Button>
    </div>
  );
}

/** Pure view: render a panel from already-resolved data. */
export function PanelView({
  panel,
  data,
  onPageChange,
}: {
  panel: Panel;
  data: unknown;
  /** Paged tables only: called with the requested 1-based page on prev/next. */
  onPageChange?: (page: number) => void;
}): JSX.Element | null {
  switch (panel.kind) {
    case 'stat': {
      const d = (data ?? {}) as {
        value?: number;
        delta?: number;
        deltaLabel?: string;
        spark?: number[];
      };
      return (
        <StatCard
          label={panel.title}
          value={formatStat(d.value ?? 0, panel.format)}
          {...(d.value !== undefined ? { currentValue: d.value } : {})}
          {...(d.delta !== undefined ? { delta: d.delta } : {})}
          {...(d.deltaLabel ? { deltaLabel: d.deltaLabel } : {})}
          {...(panel.spark && d.spark ? { spark: d.spark } : {})}
          {...(panel.thresholds ? { thresholds: panel.thresholds } : {})}
          {...(panel.accent ? { accent: panel.accent } : {})}
        />
      );
    }
    case 'distribution': {
      const d = (data ?? {}) as {
        buckets?: { label: string; count: number }[];
        p50?: number;
        p95?: number;
        p99?: number;
      };
      return (
        <DistributionChartCard
          title={panel.title}
          buckets={d.buckets ?? []}
          {...(d.p50 !== undefined ? { p50: d.p50 } : {})}
          {...(d.p95 !== undefined ? { p95: d.p95 } : {})}
          {...(d.p99 !== undefined ? { p99: d.p99 } : {})}
        />
      );
    }
    case 'gauge': {
      const d = (data ?? {}) as { value?: number; min?: number; max?: number };
      return (
        <GaugeCard
          title={panel.title}
          value={d.value ?? 0}
          {...(panel.min !== undefined ? { min: panel.min } : {})}
          {...(panel.max !== undefined ? { max: panel.max } : {})}
        />
      );
    }
    case 'breakdown': {
      const d = (data ?? {}) as { segments?: { label: string; value: number; color?: string }[] };
      return (
        <BreakdownCard
          title={panel.title}
          segments={d.segments ?? []}
          {...(panel.style ? { style: panel.style } : {})}
        />
      );
    }
    case 'timeseries': {
      const rows =
        (data as { rows?: Array<{ label: string } & Record<string, number>> })?.rows ?? [];
      const primary = panel.series[0];
      return panel.style === 'stacked' ? (
        <StackedAreaChartCard title={panel.title} data={rows} series={panel.series} />
      ) : (
        <AreaChartCard
          title={panel.title}
          data={rows.map((r) => ({
            label: r.label,
            value: primary ? Number(r[primary] ?? 0) : 0,
          }))}
        />
      );
    }
    case 'topN': {
      const items =
        (data as { items?: Array<{ label: string; value: number; id?: string }> })?.items ?? [];
      const limited = panel.limit ? items.slice(0, panel.limit) : items;
      if (limited.length === 0) return <EmptyPanel title={panel.title} />;
      return <BarChartCard title={panel.title} data={limited} horizontal truncateLabel={32} />;
    }
    case 'table': {
      if (panel.paged) {
        const d = (data ?? {}) as {
          rows?: Record<string, unknown>[];
          total?: number;
          page?: number;
          limit?: number;
        };
        const rows = d.rows ?? [];
        const page = d.page ?? 1;
        const limit = d.limit ?? (rows.length || 1);
        const total = d.total ?? rows.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        return (
          <div className="rounded-lg border border-line bg-panel/40">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <p className="text-xs font-medium text-foreground">{panel.title}</p>
              <PagerControls
                page={page}
                totalPages={totalPages}
                {...(onPageChange ? { onPageChange } : {})}
              />
            </div>
            <Table>
              <PanelHead columns={panel.columns} />
              <PanelRows columns={panel.columns} rows={rows} />
            </Table>
          </div>
        );
      }
      // Non-paged (the original, unconditional-since-launch table): identical markup
      // to the paged variant — verbatim table/head/rows via the same shared helpers
      // so it byte-for-byte matches what a paged table renders minus the pager row.
      const rows = (data as { rows?: Record<string, unknown>[] })?.rows ?? [];
      return (
        <div className="rounded-lg border border-line bg-panel/40">
          <p className="border-b border-line px-4 py-2 text-xs font-medium text-foreground">
            {panel.title}
          </p>
          <Table>
            <PanelHead columns={panel.columns} />
            <PanelRows columns={panel.columns} rows={rows} />
          </Table>
        </div>
      );
    }
    default:
      return null;
  }
}
