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
    <section className="rounded-lg border border-line bg-panel/40 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {right}
      </header>
      <div style={{ height }}>{children}</div>
    </section>
  );
}

/**
 * "Nothing in this window" body. `height` is optional: given one it reserves
 * exactly the space the chart would have taken, and without one it fills its
 * parent — which is what a card that puts something else (percentile chips) above
 * the chart needs, since there the chart's share of the body is not the card's
 * height.
 */
export function ChartEmptyState({ height }: { height?: number }): JSX.Element {
  return (
    <div
      className="flex h-full items-center justify-center text-xs text-muted-foreground"
      style={height === undefined ? undefined : { height }}
    >
      No data in window.
    </div>
  );
}
