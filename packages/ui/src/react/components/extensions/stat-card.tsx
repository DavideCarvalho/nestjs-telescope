import type { JSX } from 'react';

export function StatCard({
  label,
  value,
  accent = 'text-zinc-100',
  hint,
}: {
  label: string;
  value: string | number;
  accent?: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${accent}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-zinc-600">{hint}</p>}
    </div>
  );
}
