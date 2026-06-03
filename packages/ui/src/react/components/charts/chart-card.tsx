/** Shared card chrome (title, optional right slot, framed body) for every chart card. */
export function ChartCard({
  title,
  right,
  height = 220,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  height?: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">{title}</h3>
        {right}
      </header>
      <div style={{ height }}>{children}</div>
    </section>
  );
}

export function ChartEmptyState({ height = 220 }: { height?: number }): JSX.Element {
  return (
    <div className="flex items-center justify-center text-xs text-zinc-600" style={{ height }}>
      No data in window.
    </div>
  );
}
