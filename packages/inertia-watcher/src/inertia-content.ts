// packages/inertia-watcher/src/inertia-content.ts
import { EntryType, type RecordInput } from '@dudousxd/nestjs-telescope';

/**
 * The persisted content of one captured Inertia render. Built from the wire
 * `InertiaRenderDiagnostic` (below). The heavy `resolvedProps` field is passed
 * THROUGH to the Recorder by reference so its `redactBounded` clips + masks it
 * with the standard budget — we do nothing special for size/secrets here.
 */
export interface InertiaContent {
  component: string;
  method: string;
  url: string;
  statusCode: number;
  isPartial: boolean;
  versionMismatch: boolean;
  assetVersion: string;
  clientVersion: string | null;
  encryptHistory: boolean;
  clearHistory: boolean;
  pageBytes: number;
  ssr: boolean;
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
  /** The heavy field — the Recorder's `redactBounded` clips/masks it downstream. */
  resolvedProps: unknown;
}

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
 * Defensive structural validation of an untrusted channel message. Drops
 * anything whose `v !== 1` or that is missing the load-bearing fields — the
 * watcher then ignores it (fail-safe across producer version bumps). Never throws.
 */
export function isInertiaDiagnostic(msg: unknown): msg is InertiaRenderDiagnostic {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.v === 1 &&
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
 * Map a validated diagnostic to a `RecordInput`. `familyHash` groups all renders
 * of a component (`inertia:<component>`), mirroring `event:<name>` / `redis:<CMD>`.
 * `durationMs` is null — render time belongs to the sibling `request` entry.
 * `resolvedProps` is passed BY REFERENCE (no clone/stringify) so the Recorder's
 * `redactBounded` can traverse, clip, and mask it.
 */
export function buildInertiaContent(d: InertiaRenderDiagnostic): RecordInput<InertiaContent> {
  const tags = ['inertia', `inertia:component:${d.component}`];
  if (d.isPartial) tags.push('inertia:partial');
  if (d.versionMismatch) tags.push('inertia:version-mismatch');
  if (Object.keys(d.props.deferred ?? {}).length) tags.push('inertia:deferred');
  if ((d.props.merge?.length ?? 0) || (d.props.deepMerge?.length ?? 0)) tags.push('inertia:merge');

  return {
    type: EntryType.Inertia,
    familyHash: `inertia:${d.component}`,
    durationMs: null,
    tags,
    content: {
      component: d.component,
      method: d.method,
      url: d.url,
      statusCode: d.statusCode,
      isPartial: d.isPartial,
      versionMismatch: d.versionMismatch,
      assetVersion: d.assetVersion,
      clientVersion: d.clientVersion,
      encryptHistory: d.encryptHistory,
      clearHistory: d.clearHistory,
      pageBytes: d.pageBytes,
      ssr: d.ssr,
      partial: d.partial,
      props: d.props,
      resolvedProps: d.resolvedProps,
    },
  };
}
