export function sparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = index * stepX;
      const y = height - (value / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function Sparkline({
  values,
  width = 160,
  height = 36,
}: { values: number[]; width?: number; height?: number }): JSX.Element {
  const points = sparklinePoints(values, width, height);
  const area = points ? `0,${height} ${points} ${width},${height}` : '';
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="throughput"
    >
      {area && <polygon points={area} className="fill-emerald-500/10" />}
      {points && (
        <polyline points={points} className="fill-none stroke-emerald-400" strokeWidth={1.5} />
      )}
    </svg>
  );
}
