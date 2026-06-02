import type { EntryWithBatch } from '../../client/index.js';
import { BatchTimeline } from './batch-timeline.js';

export function EntryDetail({
  entry,
  onSelect,
}: { entry: EntryWithBatch; onSelect?: (id: string) => void }): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-6">
      <section className="col-span-2">
        <h2 className="mb-2 text-sm text-emerald-400">{entry.type}</h2>
        <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
          {JSON.stringify(entry.content, null, 2)}
        </pre>
      </section>
      <aside>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Batch ({entry.batch.length})
        </h3>
        <BatchTimeline batch={entry.batch} currentId={entry.id} onSelect={onSelect} />
      </aside>
    </div>
  );
}
