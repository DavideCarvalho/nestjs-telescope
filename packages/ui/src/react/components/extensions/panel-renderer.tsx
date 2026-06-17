import type { JSX } from 'react';
import type { Panel } from '../../../client/types.js';
import { AreaChartCard } from '../charts/area-chart-card.js';
import { BarChartCard } from '../charts/bar-chart-card.js';
import { BreakdownCard } from '../charts/breakdown-card.js';
import { DistributionChartCard } from '../charts/distribution-chart-card.js';
import { GaugeCard } from '../charts/gauge-card.js';
import { StackedAreaChartCard } from '../charts/stacked-area-chart-card.js';
import { StatCard } from './stat-card.js';

function formatStat(value: number, format?: 'number' | 'percent' | 'duration' | 'rate'): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  if (format === 'rate') return `${new Intl.NumberFormat().format(value)}/s`;
  return new Intl.NumberFormat().format(value);
}

function fillTemplate(href: string, row: Record<string, unknown>): string {
  const filled = href.replace(/\{(\w+)\}/g, (_m, k: string) => String(row[k] ?? ''));
  // The template is author-controlled but the substituted values come from provider
  // row data — never let a row turn the link into a `javascript:`/`data:` URL.
  if (/^\s*(javascript|data|vbscript):/i.test(filled)) return '#';
  return filled;
}

/** Pure view: render a panel from already-resolved data. */
export function PanelView({ panel, data }: { panel: Panel; data: unknown }): JSX.Element | null {
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
      return <BarChartCard title={panel.title} data={limited} horizontal truncateLabel={32} />;
    }
    case 'table': {
      const rows = (data as { rows?: Record<string, unknown>[] })?.rows ?? [];
      return (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <p className="border-b border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300">
            {panel.title}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr>
                {panel.columns.map((c) => (
                  <th
                    key={c.key}
                    className="px-4 py-2 text-left text-[10px] uppercase tracking-wide text-zinc-500"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={panel.columns.map((c) => String(row[c.key] ?? '')).join('|')}
                  className="border-t border-zinc-800/60"
                >
                  {panel.columns.map((c) => {
                    const text = String(row[c.key] ?? '');
                    return (
                      <td key={c.key} className="px-4 py-2 text-zinc-200">
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
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default:
      return null;
  }
}
