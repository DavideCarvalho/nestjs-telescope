import type { JSX } from 'react';

export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

function health(value: number | undefined, t?: PanelThresholds): 'ok' | 'warn' | 'bad' | null {
  if (value === undefined || !t) return null;
  const worseUp = t.direction === 'up-bad';
  if (worseUp ? value >= t.bad : value <= t.bad) return 'bad';
  if (worseUp ? value >= t.warn : value <= t.warn) return 'warn';
  return 'ok';
}

const ACCENT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
};

function Sparkline({ points }: { points: number[] }): JSX.Element | null {
  if (points.length < 2) return null;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 20 - ((p - min) / span) * 18 - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className="mt-2"
      width="100%"
      height="22"
      viewBox="0 0 100 22"
      preserveAspectRatio="none"
      aria-hidden
    >
      <title>Sparkline chart</title>
      <path d={d} fill="none" stroke="#52525b" strokeWidth="1.5" />
    </svg>
  );
}

export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  spark,
  thresholds,
  currentValue,
  accent = 'text-zinc-100',
  hint,
}: {
  label: string;
  value: string | number;
  delta?: number;
  deltaLabel?: string;
  spark?: number[];
  thresholds?: PanelThresholds;
  currentValue?: number;
  accent?: string;
  hint?: string;
}): JSX.Element {
  const h = health(currentValue, thresholds);
  // A positive delta is "good" unless higher is bad.
  const deltaGood =
    delta === undefined ? null : thresholds?.direction === 'up-bad' ? delta < 0 : delta > 0;
  const deltaColor = deltaGood === null ? '#a1a1aa' : deltaGood ? '#34d399' : '#f87171';
  const arrow = delta === undefined ? '' : delta > 0 ? '▲' : delta < 0 ? '▼' : '◆';
  return (
    <div
      data-health={h ?? undefined}
      className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 overflow-hidden"
    >
      {h && <div style={{ height: 3, background: ACCENT[h], margin: '-12px -16px 9px' }} />}
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent} flex items-baseline gap-2`}>
        {value}
        {delta !== undefined && (
          <span className="text-xs font-semibold" style={{ color: deltaColor }}>
            {arrow} {deltaLabel ?? Math.abs(delta)}
          </span>
        )}
      </p>
      {spark && <Sparkline points={spark} />}
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}
