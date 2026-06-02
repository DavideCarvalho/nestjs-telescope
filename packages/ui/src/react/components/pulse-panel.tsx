import type { PulseReport } from '../../client/index.js';

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

export function PulsePanel({
  report,
  onSelectEntry,
  onSelectBatch,
}: {
  report: PulseReport;
  onSelectEntry?: (id: string) => void;
  onSelectBatch?: (batchId: string) => void;
}): JSX.Element {
  return (
    <div className="text-xs">
      {report.truncated && (
        <p className="mb-4 text-amber-500">
          Scan truncated at {report.scanned} entries — widen the window with care.
        </p>
      )}

      <Section title="Entries by type">
        <div className="flex flex-wrap gap-3">
          {Object.entries(report.counts).map(([type, count]) => (
            <span key={type} className="rounded bg-zinc-900 px-2 py-1">
              <span className="text-emerald-400">{type}</span>{' '}
              <span className="text-zinc-300">{count}</span>
            </span>
          ))}
          {Object.keys(report.counts).length === 0 && (
            <span className="text-zinc-600">No entries in window.</span>
          )}
        </div>
      </Section>

      <Section title="Slowest">
        <table className="w-full text-left">
          <tbody>
            {report.slowest.map((slow) => (
              <tr
                key={slow.id}
                tabIndex={0}
                onClick={() => onSelectEntry?.(slow.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectEntry?.(slow.id);
                }}
                className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
              >
                <td className="py-1 text-emerald-400">{slow.type}</td>
                <td className="max-w-md truncate text-zinc-300">{slow.label}</td>
                <td className="text-right text-zinc-400">{slow.durationMs}ms</td>
              </tr>
            ))}
            {report.slowest.length === 0 && (
              <tr>
                <td className="py-1 text-zinc-600">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Top exceptions">
        <table className="w-full text-left">
          <tbody>
            {report.topExceptions.map((group) => (
              <tr key={group.familyHash} className="border-t border-zinc-900">
                <td className="py-1 text-red-400">{group.class}</td>
                <td className="max-w-md truncate text-zinc-300">{group.message}</td>
                <td className="text-right text-zinc-400">×{group.count}</td>
              </tr>
            ))}
            {report.topExceptions.length === 0 && (
              <tr>
                <td className="py-1 text-zinc-600">No exceptions 🎉</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="N+1 query hotspots">
        <table className="w-full text-left">
          <tbody>
            {report.nPlusOne.map((occurrence) => (
              <tr
                key={`${occurrence.batchId}:${occurrence.familyHash}`}
                tabIndex={0}
                onClick={() => onSelectBatch?.(occurrence.batchId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ')
                    onSelectBatch?.(occurrence.batchId);
                }}
                className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900"
              >
                <td className="py-1 text-amber-400">×{occurrence.count}</td>
                <td className="max-w-md truncate text-zinc-300">{occurrence.sql}</td>
              </tr>
            ))}
            {report.nPlusOne.length === 0 && (
              <tr>
                <td className="py-1 text-zinc-600">None detected</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
