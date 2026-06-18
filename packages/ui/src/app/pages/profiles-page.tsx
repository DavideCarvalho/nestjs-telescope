import { type JSX, useState } from 'react';
import type { CpuProfileContent, Entry, HotFrame } from '../../client/index.js';
import {
  Flamegraph,
  formatProfileMs,
  relativeTime,
  useArmProfile,
  useMeta,
  useProfile,
  useProfilerStatus,
  useProfiles,
} from '../../react/index.js';

/** Sidebar row for one captured profile. */
function ProfileRow({
  profile,
  selected,
  onSelect,
}: {
  profile: Entry;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full flex-col gap-0.5 border-b border-zinc-900 px-3 py-2 text-left hover:bg-zinc-900 ${
        selected ? 'bg-zinc-900' : ''
      }`}
    >
      <span
        className="truncate font-mono text-xs text-zinc-200"
        title={profile.familyHash ?? profile.id}
      >
        {profile.familyHash ?? '(unlabelled)'}
      </span>
      <span className="flex items-center gap-2 text-[10px] text-zinc-500">
        <span>{profile.durationMs !== null ? formatProfileMs(profile.durationMs) : '—'}</span>
        {profile.tags.includes('manual') && <span className="text-amber-400">manual</span>}
        {profile.tags.includes('sampled') && <span className="text-sky-400">sampled</span>}
        <span className="ml-auto">{relativeTime(new Date(profile.createdAt).getTime())}</span>
      </span>
    </button>
  );
}

/** "Hot functions" table (by self time), mirroring Sentry/Clinic profile views. */
function HotFunctions({ hot }: { hot: HotFrame[] }): JSX.Element {
  if (hot.length === 0) return <p className="text-xs text-zinc-600">No hot frames.</p>;
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
        <span className="flex-1">Function</span>
        <span className="w-16 text-right">Self</span>
        <span className="w-12 text-right">%</span>
      </div>
      {hot.map((frame) => (
        <div
          key={`${frame.name}:${frame.file}`}
          className="flex items-center gap-2 border-b border-zinc-900 px-3 py-1 text-[11px] last:border-0"
        >
          <span
            className="min-w-0 flex-1 truncate font-mono text-zinc-200"
            title={`${frame.name} ${frame.file}`}
          >
            {frame.name}
            {frame.file && <span className="ml-1 text-zinc-600">{frame.file}</span>}
          </span>
          <span className="w-16 text-right tabular-nums text-zinc-300">
            {formatProfileMs(frame.selfMs)}
          </span>
          <span className="w-12 text-right tabular-nums text-amber-400">
            {frame.selfPct.toFixed(1)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The flamegraph + hot-functions detail for one selected profile. */
function ProfileDetail({ id }: { id: string }): JSX.Element {
  const { data, isLoading } = useProfile(id);
  if (isLoading) return <p className="text-zinc-600">Loading profile…</p>;
  if (!data) return <p className="text-zinc-600">Profile not found.</p>;
  const content = data.content as CpuProfileContent;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="font-mono text-sm text-zinc-100">{content.label ?? '(unlabelled)'}</h3>
        <span className="text-xs text-zinc-500">
          {formatProfileMs(content.durationMs)} · {content.sampleCount} samples · {content.reason}
        </span>
      </div>
      <Flamegraph tree={content.tree} />
      <HotFunctions hot={content.hot} />
    </div>
  );
}

/** A small control to arm an on-demand capture of the next N requests. */
function ArmControl({ pendingManual }: { pendingManual: number }): JSX.Element {
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState('');
  const arm = useArmProfile();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">Capture next</span>
      <input
        type="number"
        min={1}
        value={count}
        onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
        className="w-14 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-xs text-zinc-200"
      />
      <span className="text-[10px] text-zinc-500">request(s) matching</span>
      <input
        type="text"
        placeholder="any route (e.g. GET /users/:id)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="w-56 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-xs text-zinc-200"
      />
      <button
        type="button"
        disabled={arm.isPending}
        onClick={() => arm.mutate({ count, ...(label ? { label } : {}) })}
        className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {arm.isPending ? 'Arming…' : 'Arm capture'}
      </button>
      {pendingManual > 0 && (
        <span className="text-[10px] text-amber-400">{pendingManual} pending</span>
      )}
      {arm.isError && (
        <span className="text-[10px] text-rose-400">
          {arm.error instanceof Error ? arm.error.message : 'Failed to arm (mutations disabled?)'}
        </span>
      )}
    </div>
  );
}

export function ProfilesPage(): JSX.Element {
  const meta = useMeta();
  const status = useProfilerStatus();
  const { data, isLoading } = useProfiles(100);
  const profiles = data?.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const enabled = meta.data?.profiling?.enabled ?? status.data?.enabled ?? false;
  const activeId = selectedId ?? profiles[0]?.id ?? null;

  if (!enabled) {
    return (
      <div className="space-y-3 p-4">
        <h2 className="text-sm text-emerald-400">CPU Profiles</h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-xs text-zinc-400">
          <p className="mb-2 text-zinc-300">CPU profiling is disabled.</p>
          <p>
            Enable it with{' '}
            <code className="rounded bg-zinc-800 px-1 text-emerald-300">
              profiling: {'{'} enabled: true {'}'}
            </code>{' '}
            in <code className="rounded bg-zinc-800 px-1">TelescopeModule.forRoot</code>. Profiling
            is opt-in because it carries real CPU overhead; when off there is zero cost on the
            request path.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm text-emerald-400">CPU Profiles</h2>
        {status.data && (
          <span className="text-[10px] text-zinc-500">
            sampling {(status.data.sampleRate * 100).toFixed(0)}% · {status.data.active} active
          </span>
        )}
      </div>
      <ArmControl pendingManual={status.data?.pendingManual ?? 0} />
      <div className="flex gap-4">
        <div className="w-64 shrink-0 rounded-lg border border-zinc-800">
          {isLoading ? (
            <p className="p-3 text-xs text-zinc-600">Loading…</p>
          ) : profiles.length === 0 ? (
            <p className="p-3 text-xs text-zinc-600">No profiles captured yet.</p>
          ) : (
            profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                selected={profile.id === activeId}
                onSelect={() => setSelectedId(profile.id)}
              />
            ))
          )}
        </div>
        <div className="min-w-0 flex-1">
          {activeId ? (
            <ProfileDetail id={activeId} />
          ) : (
            <p className="text-xs text-zinc-600">Select a profile to view its flamegraph.</p>
          )}
        </div>
      </div>
    </div>
  );
}
