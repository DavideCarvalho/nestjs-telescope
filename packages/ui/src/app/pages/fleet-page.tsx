import { parseAsString, useQueryState } from 'nuqs';
import { EmptyState } from '../../aviary-kit/blocks/empty-state';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../../aviary-kit/blocks/metric-card';
import { PageHeader } from '../../aviary-kit/blocks/page-header';
import { QueryBoundary } from '../../aviary-kit/blocks/query-boundary';
import { ServerIcon } from '../../aviary-kit/icons';
import { PageBody } from '../../aviary-kit/shell/app-shell';
import type {
  FleetApp,
  FleetCheckState,
  FleetDeploy,
  FleetIncident,
  FleetInstance,
  FleetView,
} from '../../client/index.js';
import { useFleet } from '../../react/index.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../react/ui/index.js';

/** `42 s`, `12 min`, `3.5 h`, `2 d`: a duration as a person reads it. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))} s`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
  if (value < 86_400_000) return `${(value / 3_600_000).toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(value / 86_400_000)} d`;
}

const STATUS_TONE: Record<string, string> = {
  up: 'text-good bg-good/10',
  ok: 'text-good bg-good/10',
  starting: 'text-info bg-info/10',
  draining: 'text-warn tint-warn',
  warn: 'text-warn tint-warn',
  gone: 'text-muted-foreground bg-panel-2',
  unknown: 'text-muted-foreground bg-panel-2',
  down: 'text-bad bg-bad/10',
};

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_TONE[status] ?? STATUS_TONE.unknown}`}
    >
      {status}
    </span>
  );
}

const INCIDENT_SURFACE: Record<string, string> = {
  down: 'border-bad/40 bg-bad/5',
  warn: 'border-warn/40 tint-warn',
  // `unknown` is neutral, like its badge: the check has not answered yet.
  unknown: 'border-line',
};

/** The HTTP server's role; every instance of an older server is one. */
const WEB_ROLE = 'web';

/** An instance's role (`web` from an older server). */
export function roleOf(item: { role?: string }): string {
  return item.role ?? WEB_ROLE;
}

/** Every role in the view, `web` first, then workers by name. */
export function rolesOf(apps: FleetApp[]): string[] {
  const roles = new Set<string>();
  for (const app of apps) for (const instance of app.instances) roles.add(roleOf(instance));
  return [...roles].sort((a, b) =>
    a === b ? 0 : a === WEB_ROLE ? -1 : b === WEB_ROLE ? 1 : a.localeCompare(b),
  );
}

/**
 * An app narrowed to one role: its instances and restart loops of that role, and the cards
 * recounted from them. Deploys, failing checks and the send buffer are computed by the server over
 * every role, so they are left out of a narrowed app rather than shown wrong. `null` keeps the
 * app as the server sent it.
 */
export function narrowToRole(app: FleetApp, role: string | null): FleetApp {
  if (role === null) return app;
  const instances = app.instances.filter((instance) => roleOf(instance) === role);
  const counts = { up: 0, starting: 0, draining: 0, gone: 0 };
  for (const instance of instances) counts[instance.status] += 1;
  return {
    ...app,
    counts,
    instances,
    restartLoops: app.restartLoops.filter((loop) => roleOf(loop) === role),
    deploys: [],
    checks: [],
    shipping: null,
  };
}

function RoleBadge({ role }: { role: string }): React.JSX.Element {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${role === WEB_ROLE ? 'bg-panel-2 text-muted-foreground' : 'bg-info/10 text-info'}`}
    >
      {role}
    </span>
  );
}

function versionLabel(version: string | null): string {
  return version ?? 'unknown version';
}

/** `2/5 live`, `complete`, or `no live instances` (a rollout with nothing running). */
export function rolloutLabel(deploy: FleetDeploy): string {
  if (deploy.total === 0) return 'no live instances';
  if (deploy.complete) return 'complete';
  return `${deploy.live}/${deploy.total} live`;
}

/** `Redis: down for 12 min on 4 of 4 instances`. */
export function incidentLabel(incident: FleetIncident, now: number): string {
  return `${incident.name}: ${incident.status} for ${formatDuration(now - incident.since)} on ${incident.affected} of ${incident.of} instance${incident.of === 1 ? '' : 's'}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{title}</h3>
      {children}
    </section>
  );
}

function Incidents({
  incidents,
  now,
  onOpenEntry,
}: {
  incidents: FleetIncident[];
  now: number;
  onOpenEntry: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {incidents.map((incident) => (
        <div
          key={incident.name}
          className={`rounded-lg border p-3 text-xs ${INCIDENT_SURFACE[incident.status] ?? 'border-line'}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={incident.status} />
            <span className="font-medium text-foreground">{incidentLabel(incident, now)}</span>
            {!incident.critical && <span className="text-faint">(not critical)</span>}
          </div>
          {incident.message && (
            <p className="mt-1 break-words text-muted-foreground">{incident.message}</p>
          )}
          {incident.exceptions.length > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-[10px] uppercase tracking-[0.12em] text-faint">
                Exceptions since
              </div>
              {incident.exceptions.map((exception) => (
                <button
                  key={exception.entryId}
                  type="button"
                  onClick={() => onOpenEntry(exception.entryId)}
                  className="block w-full truncate rounded px-1 py-0.5 text-left font-mono text-[11px] text-foreground hover:bg-panel-2"
                  title={`${exception.class}: ${exception.message}`}
                >
                  <span className="text-bad">{exception.class}</span> {exception.message}{' '}
                  <span className="text-faint">×{exception.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function worstCheck(checks: FleetCheckState[]): FleetCheckState | undefined {
  const rank = { ok: 0, unknown: 1, warn: 2, down: 3 } as const;
  return [...checks].sort((a, b) => rank[b.status] - rank[a.status])[0];
}

function InstancesTable({
  instances,
  now,
}: {
  instances: FleetInstance[];
  now: number;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <Table className="min-w-[720px] text-left text-xs">
        <TableHeader>
          <TableRow className="text-[10px] uppercase tracking-[0.12em] text-faint">
            <TableHead>Host</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Uptime</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Buffer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {instances.map((instance) => {
            const worst = worstCheck(instance.checks);
            return (
              <TableRow key={instance.instanceId} className="border-t border-line/60">
                <TableCell className="font-mono" title={instance.instanceId}>
                  {instance.host}
                </TableCell>
                <TableCell>
                  <RoleBadge role={roleOf(instance)} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={instance.status} />
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {versionLabel(instance.version)}
                </TableCell>
                <TableCell className="tabular-nums">{formatDuration(instance.uptimeMs)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatDuration(now - instance.lastSeenAt)} ago
                </TableCell>
                <TableCell>
                  {instance.checks.length === 0 ? (
                    <span className="text-faint">no checks</span>
                  ) : (
                    <span title={worst?.message ?? undefined}>
                      <StatusBadge status={instance.health} />
                      {worst && worst.status !== 'ok' ? (
                        <span className="ml-1 text-muted-foreground">{worst.name}</span>
                      ) : null}
                    </span>
                  )}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {instance.shipping === null
                    ? '—'
                    : `${instance.shipping.buffered} waiting · ${instance.shipping.dropped} dropped`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AppFleet({
  app,
  now,
  onOpenEntry,
}: {
  app: FleetApp;
  now: number;
  onOpenEntry: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="space-y-4 rounded-xl border border-line p-4">
      <h2 className="font-mono text-sm font-semibold text-foreground">{app.app}</h2>
      <MetricGrid>
        <MetricCard label="Up" value={app.counts.up} tone={app.counts.up > 0 ? 'good' : 'bad'} />
        <MetricCard label="Starting" value={app.counts.starting} tone="info" />
        <MetricCard label="Draining" value={app.counts.draining} tone="warn" />
        <MetricCard label="Gone" value={app.counts.gone} />
        {app.shipping && (
          <MetricCard
            label="Send buffer"
            value={app.shipping.buffered}
            tone={app.shipping.dropped > 0 ? 'warn' : 'default'}
            caption={`${app.shipping.dropped} dropped · lag ${formatDuration(app.shipping.maxLagMs)}`}
          />
        )}
      </MetricGrid>

      {app.checks.length > 0 && (
        <Section title="Failing checks">
          <Incidents incidents={app.checks} now={now} onOpenEntry={onOpenEntry} />
        </Section>
      )}

      {app.restartLoops.length > 0 && (
        <Section title="Restart loops">
          <ul className="space-y-1 text-xs">
            {app.restartLoops.map((loop) => (
              <li
                key={`${loop.host}:${roleOf(loop)}`}
                className="rounded border border-bad/40 bg-bad/5 px-2 py-1"
              >
                <span className="font-mono">{loop.host}</span>
                {roleOf(loop) !== WEB_ROLE ? (
                  <span className="text-muted-foreground"> ({roleOf(loop)})</span>
                ) : null}{' '}
                restarted {loop.restarts} times in {formatDuration(now - loop.since)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {app.deploys.length > 0 && (
        <Section title="Deploys">
          <ul className="space-y-1 text-xs">
            {[...app.deploys].reverse().map((deploy) => (
              <li
                key={`${deploy.version}:${deploy.startedAt}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-mono text-muted-foreground">
                  {versionLabel(deploy.previous)} → {versionLabel(deploy.version)}
                </span>
                <span className="text-faint">{formatDuration(now - deploy.startedAt)} ago</span>
                <span className={deploy.complete ? 'text-good' : 'text-info'}>
                  {rolloutLabel(deploy)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Instances">
        <InstancesTable instances={app.instances} now={now} />
      </Section>
    </section>
  );
}

/** The Fleet page's content, from a {@link FleetView}. */
export function FleetSection({
  view,
  onOpenEntry,
}: {
  view: FleetView;
  onOpenEntry: (id: string) => void;
}): React.JSX.Element {
  if (view.notice !== null || !view.enabled) {
    return (
      <EmptyState
        icon={<ServerIcon />}
        title={view.enabled ? 'The fleet is hidden' : 'No fleet here'}
        description={view.notice ?? 'This telescope keeps no fleet.'}
      />
    );
  }
  if (view.apps.length === 0) {
    return (
      <EmptyState
        icon={<ServerIcon />}
        title="No instance has reported yet"
        description="Instances appear once their first heartbeat arrives."
      />
    );
  }
  return <FleetApps view={view} onOpenEntry={onOpenEntry} />;
}

/** The apps, with a role filter once the fleet runs more than one kind of process. */
function FleetApps({
  view,
  onOpenEntry,
}: {
  view: FleetView;
  onOpenEntry: (id: string) => void;
}): React.JSX.Element {
  // `?role=<role>`; no param is All roles. Picking a role adds a history entry.
  const [role, setRole] = useQueryState('role', parseAsString.withOptions({ history: 'push' }));
  const roles = rolesOf(view.apps);
  // A role that left the fleet (or one picked before a refresh dropped it) shows everything.
  const selected = role !== null && roles.includes(role) ? role : null;
  const apps = view.apps
    .map((app) => narrowToRole(app, selected))
    .filter((app) => selected === null || app.instances.length > 0);
  return (
    <div className="space-y-6">
      {roles.length > 1 && (
        <fieldset className="flex flex-wrap items-center gap-1 text-xs">
          <legend className="sr-only">Role</legend>
          {[null, ...roles].map((option) => (
            <button
              key={option ?? '*'}
              type="button"
              aria-pressed={selected === option}
              onClick={() => void setRole(option)}
              className={`rounded border px-2 py-0.5 font-mono ${selected === option ? 'border-info bg-info/10 text-info' : 'border-line text-muted-foreground hover:bg-panel-2'}`}
            >
              {option ?? 'All roles'}
            </button>
          ))}
        </fieldset>
      )}
      {selected !== null && (
        <p className="text-xs text-faint">
          Showing {selected} instances and restart loops. Deploys, failing checks and the send
          buffer cover every role: pick All roles to see them.
        </p>
      )}
      {apps.map((app) => (
        <AppFleet key={app.app} app={app} now={view.now} onOpenEntry={onOpenEntry} />
      ))}
    </div>
  );
}

function FleetSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4" aria-busy="true">
      <MetricGridSkeleton count={4} />
      <div className="h-40 animate-pulse rounded-lg border border-line bg-panel-2/40" />
    </div>
  );
}

/** Monitor → Fleet: every app's instances, deploys, restart loops and failing checks. */
export function FleetPage(): React.JSX.Element {
  const fleet = useFleet();
  const openEntry = (id: string) => {
    window.location.hash = `#/entries/view/${encodeURIComponent(id)}`;
  };
  return (
    <PageBody>
      <PageHeader
        title="Fleet"
        description="Every instance's last heartbeat (web servers and workers): who is up, deploys and their rollout, restart loops, and failing health checks with the exceptions recorded since."
      />
      <QueryBoundary query={fleet} label="Fleet" skeleton={<FleetSkeleton />}>
        {(view) => <FleetSection view={view} onOpenEntry={openEntry} />}
      </QueryBoundary>
    </PageBody>
  );
}
