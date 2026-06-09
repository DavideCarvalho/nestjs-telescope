// packages/inertia-watcher/src/inertia-content.ts
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

/**
 * The persisted content of one captured Inertia render: the wire
 * `InertiaRenderDiagnostic` (below) minus the transport-only `v` and the
 * always-true `isInertia` discriminator. Defined as an `Omit` so it can never
 * drift from the wire shape. The heavy `resolvedProps` field is passed THROUGH
 * to the Recorder by reference so its `redactBounded` clips + masks it with the
 * standard budget — we do nothing special for size/secrets here.
 */
export type InertiaContent = Omit<InertiaRenderDiagnostic, 'v' | 'isInertia'>;

/**
 * The wire payload published by `@dudousxd/nestjs-inertia` on the
 * `nestjs-inertia:render` channel. This shape is the source of truth in
 * nestjs-inertia's `src/diagnostics.ts` (`InertiaRenderDiagnostic`, spec §1.3);
 * it is duplicated here STRUCTURALLY (never imported) so the two libraries stay
 * decoupled. Validate with `isInertiaDiagnostic` before trusting it.
 */
export interface InertiaRenderDiagnostic {
  v: number;
  component: string;
  url: string;
  method: string;
  isInertia: boolean;
  isPartial: boolean;
  partial: { only: string[]; except: string[]; reset: string[]; resetOnce: string[] };
  props: {
    sharedKeys: string[];
    finalKeys: string[];
    deferred: Record<string, string[]>;
    merge: string[];
    deepMerge: string[];
    matchPropsOn: Record<string, string>;
    optionalKeys: string[];
    onceKeys: string[];
    excludedKeys: string[];
  };
  resolvedProps: unknown;
  assetVersion: string;
  versionMismatch: boolean;
  clientVersion: string | null;
  encryptHistory: boolean;
  clearHistory: boolean;
  statusCode: number;
  pageBytes: number;
  ssr: boolean;
}

/**
 * True when a message is shaped like our diagnostic — it carries a numeric `v`
 * and the load-bearing render fields — REGARDLESS of version. Lets the watcher
 * tell "Inertia-shaped but unsupported `v`" (warn once) apart from ordinary
 * non-Inertia channel noise (drop silently). Never throws.
 */
export function isInertiaShaped(
  msg: unknown,
): msg is { v: number } & Partial<InertiaRenderDiagnostic> {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    typeof m.v === 'number' &&
    typeof m.component === 'string' &&
    typeof m.url === 'string' &&
    typeof m.method === 'string' &&
    typeof m.props === 'object' &&
    m.props !== null &&
    typeof m.partial === 'object' &&
    m.partial !== null
  );
}

/**
 * Defensive structural validation of an untrusted channel message: Inertia-shaped
 * AND a supported `v === 1`. The watcher records only these (fail-safe across
 * producer version bumps). Narrowed return type — this proves the version and the
 * load-bearing fields it actually checks, not the whole payload; the UI re-reads
 * every other field defensively. Never throws.
 */
export function isInertiaDiagnostic(
  msg: unknown,
): msg is { v: 1 } & Partial<InertiaRenderDiagnostic> {
  return isInertiaShaped(msg) && msg.v === 1;
}

/** Build the tag list for one render: base tags + partial/mismatch/deferred/merge flags. */
function buildTags(d: InertiaRenderDiagnostic): string[] {
  const tags = ['inertia', `inertia:component:${d.component}`];
  if (d.isPartial) tags.push('inertia:partial');
  if (d.versionMismatch) tags.push('inertia:version-mismatch');
  if (Object.keys(d.props.deferred ?? {}).length) tags.push('inertia:deferred');
  if ((d.props.merge?.length ?? 0) || (d.props.deepMerge?.length ?? 0)) tags.push('inertia:merge');
  return tags;
}

/**
 * Map a validated diagnostic to a `RecordInput`. `familyHash` groups all renders
 * of a component (`inertia:<component>`), mirroring `event:<name>` / `redis:<CMD>`.
 * `durationMs` is null — render time belongs to the sibling `request` entry. The
 * content is the wire payload minus `v`/`isInertia` via destructure-rest, so the
 * heavy `resolvedProps` is carried BY REFERENCE (no clone/stringify) for the
 * Recorder's `redactBounded` to traverse, clip, and mask.
 */
export function buildInertiaContent(d: InertiaRenderDiagnostic): RecordInput<InertiaContent> {
  const { v, isInertia, ...content } = d;
  return {
    type: EntryType.Inertia,
    familyHash: `inertia:${d.component}`,
    durationMs: null,
    tags: buildTags(d),
    content,
  };
}
