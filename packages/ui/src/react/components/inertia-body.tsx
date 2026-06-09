import { prettyJson } from './entry-detail.js';
import { humanBytes } from './inertia-badge.js';

/**
 * The detail body for an `inertia` entry. Renders the rendered component, the
 * partial-reload decision, prop classification, deferred groups, the resolved
 * props tree, history flags and response size. Every field is read defensively
 * — the content may have been redacted/clipped by the Recorder, and an older
 * producer may omit fields — so nothing is assumed beyond `component`.
 */
export function InertiaBody({ content }: { content: unknown }): JSX.Element {
  const record =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {};

  const component = typeof record.component === 'string' ? record.component : '';
  const method = typeof record.method === 'string' ? record.method : '';
  const url = typeof record.url === 'string' ? record.url : '';
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : null;
  const isPartial = record.isPartial === true;
  const versionMismatch = record.versionMismatch === true;
  const assetVersion = typeof record.assetVersion === 'string' ? record.assetVersion : null;
  const clientVersion = typeof record.clientVersion === 'string' ? record.clientVersion : null;
  const encryptHistory = record.encryptHistory === true;
  const clearHistory = record.clearHistory === true;
  const pageBytes = typeof record.pageBytes === 'number' ? record.pageBytes : 0;
  const ssr = record.ssr === true;

  const partial = readPartial(record.partial);
  const props = readProps(record.props);
  const excluded = unique([...partial.except, ...props.excludedKeys]);

  return (
    <div>
      {/* 1. Header */}
      <h3 className="mb-2 flex flex-wrap items-center gap-2 font-mono text-sm text-cyan-400">
        {method ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] uppercase">{method}</span>
        ) : null}
        {url ? <span className="text-zinc-400">{url}</span> : null}
        <span className="text-zinc-500">→</span>
        <span className="text-zinc-200">{component}</span>
        {statusCode !== null ? (
          <span
            className={`rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] ${
              statusCode === 409 ? 'text-red-400' : 'text-zinc-500'
            }`}
          >
            {statusCode}
          </span>
        ) : null}
        {isPartial ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-amber-400">
            partial
          </span>
        ) : null}
        {assetVersion ? (
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">
            asset {assetVersion}
          </span>
        ) : null}
      </h3>

      {versionMismatch ? (
        <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          Version mismatch: client <code className="font-mono">{clientVersion ?? 'unknown'}</code> ≠
          server <code className="font-mono">{assetVersion ?? 'unknown'}</code> → 409 forced full
          reload.
        </div>
      ) : null}

      {/* 2. Partial-reload panel */}
      {isPartial ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Partial reload</h3>
          <div className="grid grid-cols-2 gap-3">
            <KeyColumn label="Kept" keys={partial.only} accent="text-emerald-300" />
            <KeyColumn label="Excluded" keys={excluded} accent="text-red-300" />
          </div>
          {partial.reset.length > 0 || partial.resetOnce.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-3">
              <ChipRow label="reset" keys={partial.reset} accent="text-amber-300" />
              <ChipRow label="reset-once" keys={partial.resetOnce} accent="text-amber-300" />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 3. Prop classification */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Props</h3>
        <div className="flex flex-col gap-1.5">
          <ChipRow label="Shared" keys={props.sharedKeys} accent="text-sky-300" />
          <ChipRow label="Final" keys={props.finalKeys} accent="text-zinc-300" />
          <ChipRow label="Optional" keys={props.optionalKeys} accent="text-indigo-300" />
          <ChipRow label="Once" keys={props.onceKeys} accent="text-fuchsia-300" />
          <ChipRow
            label="Merge"
            keys={props.merge}
            accent="text-teal-300"
            annotations={props.matchPropsOn}
          />
          <ChipRow
            label="Deep-merge"
            keys={props.deepMerge}
            accent="text-teal-300"
            annotations={props.matchPropsOn}
          />
        </div>
      </div>

      {/* 4. Deferred groups */}
      {Object.keys(props.deferred).length > 0 ? (
        <div className="mb-4">
          <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Deferred</h3>
          <div className="flex flex-col gap-1.5">
            {Object.entries(props.deferred).map(([group, paths]) => (
              <div key={group} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-violet-300">{group}:</span>
                {paths.map((path) => (
                  <span
                    key={path}
                    className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                  >
                    {path}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 5. Resolved props tree */}
      <div className="mb-4">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Resolved props</h3>
        <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-300">
          {prettyJson(record.resolvedProps)}
        </pre>
      </div>

      {/* 6 + 7. History flags & response */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FlagChip label="encryptHistory" on={encryptHistory} />
        <FlagChip label="clearHistory" on={clearHistory} />
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
          {humanBytes(pageBytes)}
        </span>
        <span className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
          SSR: {ssr ? 'yes' : 'no'}
        </span>
      </div>
    </div>
  );
}

interface PartialDecision {
  only: string[];
  except: string[];
  reset: string[];
  resetOnce: string[];
}

function readPartial(value: unknown): PartialDecision {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    only: strArray(record.only),
    except: strArray(record.except),
    reset: strArray(record.reset),
    resetOnce: strArray(record.resetOnce),
  };
}

interface PropClassification {
  sharedKeys: string[];
  finalKeys: string[];
  deferred: Record<string, string[]>;
  merge: string[];
  deepMerge: string[];
  matchPropsOn: Record<string, string>;
  optionalKeys: string[];
  onceKeys: string[];
  excludedKeys: string[];
}

function readProps(value: unknown): PropClassification {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const deferred =
    typeof record.deferred === 'object' && record.deferred !== null
      ? (record.deferred as Record<string, string[]>)
      : {};
  const matchPropsOn =
    typeof record.matchPropsOn === 'object' && record.matchPropsOn !== null
      ? (record.matchPropsOn as Record<string, string>)
      : {};
  return {
    sharedKeys: strArray(record.sharedKeys),
    finalKeys: strArray(record.finalKeys),
    deferred,
    merge: strArray(record.merge),
    deepMerge: strArray(record.deepMerge),
    matchPropsOn,
    optionalKeys: strArray(record.optionalKeys),
    onceKeys: strArray(record.onceKeys),
    excludedKeys: strArray(record.excludedKeys),
  };
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** A labelled inline row of key chips; renders nothing when there are no keys. */
function ChipRow({
  label,
  keys,
  accent,
  annotations,
}: {
  label: string;
  keys: string[];
  accent: string;
  annotations?: Record<string, string>;
}): JSX.Element | null {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 shrink-0 text-[11px] text-zinc-500">{label}</span>
      {keys.map((key) => {
        const match = annotations?.[key];
        return (
          <span
            key={key}
            className={`rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] ${accent}`}
          >
            {key}
            {match ? <span className="text-zinc-500"> · {match}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** A labelled column of key chips for the partial-reload Kept/Excluded panels. */
function KeyColumn({
  label,
  keys,
  accent,
}: { label: string; keys: string[]; accent: string }): JSX.Element {
  return (
    <div className="rounded bg-zinc-900 p-2">
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      {keys.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {keys.map((key) => (
            <span key={key} className={`font-mono text-[10px] ${accent}`}>
              {key}
            </span>
          ))}
        </div>
      ) : (
        <span className="text-[10px] text-zinc-600">—</span>
      )}
    </div>
  );
}

/** A boolean flag chip: green when on, neutral when off. */
function FlagChip({ label, on }: { label: string; on: boolean }): JSX.Element {
  return (
    <span
      className={`rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] ${
        on ? 'text-emerald-400' : 'text-zinc-600'
      }`}
    >
      {label}: {on ? 'on' : 'off'}
    </span>
  );
}
