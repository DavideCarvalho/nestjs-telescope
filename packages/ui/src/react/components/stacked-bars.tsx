import type { TimeseriesBucket } from '../../client/index.js';

/** Tailwind `fill-*` classes per known entry type (extras fall back). */
export const TYPE_COLOR: Record<string, string> = {
  request: 'fill-emerald-400',
  query: 'fill-sky-400',
  job: 'fill-violet-400',
  exception: 'fill-red-400',
  http_client: 'fill-amber-400',
  mail: 'fill-pink-400',
};
const FALLBACK_COLOR = 'fill-zinc-500';

export function colorForType(type: string): string {
  return TYPE_COLOR[type] ?? FALLBACK_COLOR;
}

/** Ordered union of types present across buckets (known order first, then extras). */
export function deriveTypes(buckets: TimeseriesBucket[]): string[] {
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const type of Object.keys(bucket.byType)) seen.add(type);
  }
  const known = Object.keys(TYPE_COLOR).filter((type) => seen.has(type));
  const extras = [...seen].filter((type) => !(type in TYPE_COLOR)).sort();
  return [...known, ...extras];
}

export interface BarSegment {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
}

/** Compute stacked rects (bottom-up) for each bucket × type. Pure + testable. */
export function stackedBarLayout(
  buckets: TimeseriesBucket[],
  types: string[],
  width: number,
  height: number,
): BarSegment[] {
  if (buckets.length === 0) return [];
  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const barWidth = width / buckets.length;
  const segments: BarSegment[] = [];
  buckets.forEach((bucket, index) => {
    let yCursor = height;
    for (const type of types) {
      const value = bucket.byType[type] ?? 0;
      if (value === 0) continue;
      const segHeight = (value / maxTotal) * height;
      yCursor -= segHeight;
      segments.push({ x: index * barWidth, y: yCursor, width: barWidth, height: segHeight, type });
    }
  });
  return segments;
}

export function StackedBars({
  buckets,
  width = 640,
  height = 48,
}: { buckets: TimeseriesBucket[]; width?: number; height?: number }): JSX.Element {
  const types = deriveTypes(buckets);
  const segments = stackedBarLayout(buckets, types, width, height);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="throughput by type"
    >
      {segments.map((segment, index) => (
        <rect
          key={`${segment.type}-${segment.x}-${index}`}
          x={segment.x}
          y={segment.y}
          width={Math.max(0, segment.width - 0.5)}
          height={segment.height}
          className={colorForType(segment.type)}
        />
      ))}
    </svg>
  );
}
