import type { Entry } from '../../client/index.js';
import { entryLabel } from './entries-table.js';

export function BatchTimeline({
  batch,
  currentId,
  onSelect,
}: {
  batch: Entry[];
  currentId: string;
  onSelect?: ((id: string) => void) | undefined;
}): JSX.Element {
  return (
    <ol className="space-y-1">
      {[...batch]
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSelect?.(entry.id)}
              className={`flex w-full justify-between gap-4 px-2 py-1 text-left text-xs ${
                entry.id === currentId
                  ? 'bg-panel-2 text-brand'
                  : 'text-muted-foreground hover:bg-panel'
              }`}
            >
              <span>
                <span className="text-brand">{entry.type}</span> {entryLabel(entry)}
              </span>
              <span className="text-muted-foreground">
                {entry.durationMs != null ? `${entry.durationMs}ms` : ''}
              </span>
            </button>
          </li>
        ))}
    </ol>
  );
}
