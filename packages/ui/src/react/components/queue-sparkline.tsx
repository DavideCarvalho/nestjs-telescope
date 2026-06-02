import { useTimeseries } from '../use-telescope-queries.js';
import { Sparkline } from './sparkline.js';

export function QueueSparkline({ queue, window }: { queue: string; window: string }): JSX.Element {
  const { data } = useTimeseries({ window, tag: `queue:${queue}`, buckets: 24 });
  return (
    <Sparkline
      values={(data?.buckets ?? []).map((bucket) => bucket.total)}
      width={120}
      height={20}
    />
  );
}
