import type { PulseReport } from '../../client/index.js';

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function PulsePanel({
  report,
  onSelectEntry,
  onSelectFamily,
  onSelectRoute,
  onSelectOutgoing,
}: {
  report: PulseReport;
  onSelectEntry?: (id: string) => void;
  onSelectFamily?: (familyHash: string) => void;
  onSelectRoute?: (route: string) => void;
  onSelectOutgoing?: (route: string) => void;
}): JSX.Element {
  return (
    <div className="text-xs">
      {report.truncated && (
        <p className="mb-4 text-warn">
          Scan truncated at {report.scanned} entries — widen the window with care.
        </p>
      )}

      <Section title="Entries by type">
        <div className="flex flex-wrap gap-3">
          {Object.entries(report.counts).map(([type, count]) => (
            <span key={type} className="rounded bg-panel px-2 py-1">
              <span className="text-brand">{type}</span>{' '}
              <span className="text-foreground">{count}</span>
            </span>
          ))}
          {Object.keys(report.counts).length === 0 && (
            <span className="text-muted-foreground">No entries in window.</span>
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
                className="cursor-pointer border-t border-line-soft hover:bg-panel"
              >
                <td className="py-1 text-brand">{slow.type}</td>
                <td className="max-w-md truncate text-foreground">{slow.label}</td>
                <td className="text-right text-muted-foreground">{slow.durationMs}ms</td>
              </tr>
            ))}
            {report.slowest.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Top exceptions">
        <table className="w-full text-left">
          <tbody>
            {report.topExceptions.map((group) => (
              <tr key={group.familyHash} className="border-t border-line-soft">
                <td className="py-1 text-bad">{group.class}</td>
                <td className="max-w-md truncate text-foreground">{group.message}</td>
                <td className="text-right text-muted-foreground">×{group.count}</td>
              </tr>
            ))}
            {report.topExceptions.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">No exceptions 🎉</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="N+1 query hotspots">
        <table className="w-full text-left">
          <tbody>
            {report.nPlusOne.map((hotspot) => (
              <tr
                key={hotspot.familyHash}
                tabIndex={0}
                onClick={() => onSelectFamily?.(hotspot.familyHash)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ')
                    onSelectFamily?.(hotspot.familyHash);
                }}
                className="cursor-pointer border-t border-line-soft hover:bg-panel"
              >
                <td className="whitespace-nowrap py-1 text-warn">
                  ×{hotspot.perRequest}
                  <span className="text-muted-foreground"> per request</span>
                </td>
                <td className="max-w-md truncate text-foreground">{hotspot.sql}</td>
                <td className="whitespace-nowrap text-right text-muted-foreground">
                  {hotspot.requests} requests · {hotspot.total} total
                </td>
              </tr>
            ))}
            {report.nPlusOne.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">None detected</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Slow request hotspots">
        <table className="w-full text-left">
          <tbody>
            {report.slowRoutes.map((route) => (
              <tr
                key={route.route}
                tabIndex={0}
                onClick={() => onSelectRoute?.(route.route)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectRoute?.(route.route);
                }}
                className="cursor-pointer border-t border-line-soft hover:bg-panel"
              >
                <td className="max-w-md truncate py-1 font-mono text-foreground">{route.route}</td>
                <td className="whitespace-nowrap text-right text-warn">
                  {route.p99}ms
                  <span className="text-muted-foreground"> p99</span>
                </td>
                <td className="whitespace-nowrap text-right text-muted-foreground">
                  ×{route.count}
                </td>
              </tr>
            ))}
            {report.slowRoutes.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">No routes over the slow threshold</td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section title="Slow outgoing HTTP">
        <table className="w-full text-left">
          <tbody>
            {report.slowOutgoing.map((target) => (
              <tr
                key={target.route}
                tabIndex={0}
                onClick={() => onSelectOutgoing?.(target.route)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') onSelectOutgoing?.(target.route);
                }}
                className="cursor-pointer border-t border-line-soft hover:bg-panel"
              >
                <td className="max-w-md truncate py-1 font-mono text-foreground">{target.route}</td>
                <td className="whitespace-nowrap text-right text-warn">
                  {target.p99}ms
                  <span className="text-muted-foreground"> p99</span>
                </td>
                <td className="whitespace-nowrap text-right text-muted-foreground">
                  ×{target.count}
                </td>
              </tr>
            ))}
            {report.slowOutgoing.length === 0 && (
              <tr>
                <td className="py-1 text-muted-foreground">
                  No outgoing calls over the slow threshold
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
