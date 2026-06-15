import type { JSX } from 'react';
import type { Panel } from '../../../client/types.js';
import { AreaChartCard } from '../charts/area-chart-card.js';
import { StackedAreaChartCard } from '../charts/stacked-area-chart-card.js';
import { BarChartCard } from '../charts/bar-chart-card.js';
import { StatCard } from './stat-card.js';

function formatStat(value: number, format?: 'number' | 'percent' | 'duration'): string {
  if (format === 'percent') return `${Math.round(value * 100)}%`;
  if (format === 'duration')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  return new Intl.NumberFormat().format(value);
}

function fillTemplate(href: string, row: Record<string, unknown>): string {
  return href.replace(/\{(\w+)\}/g, (_m, k: string) => String(row[k] ?? ''));
}

/** Pure view: render a panel from already-resolved data. */
export function PanelView({ panel, data }: { panel: Panel; data: unknown }): JSX.Element {
  switch (panel.kind) {
    case 'stat': {
      const d = (data ?? {}) as { value?: number };
      return (
        <StatCard
          label={panel.title}
          value={formatStat(d.value ?? 0, panel.format)}
          {...(panel.accent ? { accent: panel.accent } : {})}
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
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
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
  }
}
