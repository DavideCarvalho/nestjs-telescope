// packages/core/src/redaction/redact.ts

export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api-key',
  'api_key',
  'apikey',
  'x-api-key',
  'client_secret',
  'private_key',
];

/**
 * Hard, on-by-default bounds that cap how much `redact()` clones from a single
 * input. These exist because `redact()` doubles as the synchronous detach that
 * snapshots watcher content into a plain, reference-free object (see the
 * performance milestone spec §A.1): a host's `req.user` can be a hydrated ORM
 * entity with tens-of-KB..MB of enumerable graph. Cloning it whole produced a
 * working set of `prune.after × ingest rate × bytes_per_entry` large enough to
 * drive a GC death spiral at container limits. These defaults are generous
 * enough that a NORMAL request/query/cache entry is cloned byte-identically; they
 * only bite on pathological mega-graphs, so they are the incident's by-design fix.
 */
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 8_192;
const DEFAULT_MAX_ARRAY_LENGTH = 200;
const DEFAULT_MAX_NODES = 5_000;
const DEFAULT_MAX_CONTENT_BYTES = 16_384;
/** Approximate per-node overhead charged against `maxContentBytes` (keys,
 *  punctuation, numbers — a coarse stand-in for serialized size). */
const NODE_BYTE_OVERHEAD = 8;

/** Marker substituted for a subtree pruned because it exceeded `maxDepth`. */
const DEPTH_MARKER = '[Truncated: depth]';
/** Suffix appended to a string clipped to `maxStringLength`. */
const STRING_TRUNCATION_SUFFIX = '…[truncated]';
/** Marker substituted for a subtree pruned because the node budget ran out. */
const SIZE_MARKER = '[Truncated: size]';

export interface RedactOptions {
  /** Extra keys to mask (merged with DEFAULT_REDACT_KEYS, case-insensitive). */
  keys?: string[];
  /**
   * Exact dot-paths to mask regardless of key name, e.g. `'body.ssn'`.
   * Unlike `keys` (which match that key at any depth), a path must match the
   * full traversal location from the root of the value passed to `redact()`.
   */
  paths?: string[];
  /** Replacement string. Defaults to '[REDACTED]'. */
  mask?: string;
  /**
   * Maximum object/array nesting depth to clone. Beyond it, the subtree is
   * replaced with `'[Truncated: depth]'`. ON BY DEFAULT (8). This bounds a deep
   * recursive graph (e.g. an ORM entity referencing its EntityManager → identity
   * map → entities) regardless of how the host shaped it.
   */
  maxDepth?: number;
  /**
   * Maximum cloned string length. Longer strings are clipped to the first N
   * chars plus a `'…[truncated]'` suffix. ON BY DEFAULT (8_192). Defeats a single
   * mega-string field (a serialized blob, a base64 payload) ballooning an entry.
   */
  maxStringLength?: number;
  /**
   * Maximum number of array items to clone. Longer arrays keep the first N items
   * and append a final `'[Truncated: N of M items]'` marker element. ON BY
   * DEFAULT (200). Bounds high-cardinality collections (a full result set, a
   * relation collection) without losing the head of the list.
   */
  maxArrayLength?: number;
  /**
   * Per-call walked-node budget: every object, array, and leaf visited counts
   * against it. Once exhausted, remaining subtrees become `'[Truncated: size]'`.
   * ON BY DEFAULT (5_000). This is the overall bytes-ish cap that bounds a
   * mega-graph regardless of its SHAPE — wide, deep, or both — so a single fat
   * entry can never retain an unbounded clone.
   */
  maxNodes?: number;
  /**
   * Approximate serialized-byte budget per cloned content: every string charges
   * its length, every visited node a small fixed overhead. Once exhausted,
   * remaining subtrees become `'[Truncated: size]'`. ON BY DEFAULT (16_384).
   * This is the DETERMINISTIC cap on `bytes_per_entry` — the third factor of the
   * OOM working-set formula (`prune.after × ingest rate × bytes_per_entry`) —
   * and the bound that bites on incident-class payloads made of MANY SMALL
   * strings (an ORM user graph) that slip under the node/string/array limits.
   */
  maxContentBytes?: number;
}

/** Result of a bounded redaction: the detached clone plus whether anything was clipped. */
export interface RedactBoundedResult {
  /** The detached, masked, bounded clone. */
  value: unknown;
  /** True when any bound (depth/string/array/node) clipped some content. */
  truncated: boolean;
}

/**
 * The masking decision derived from {@link RedactOptions}, compiled ONCE so the
 * per-entry hot path never rebuilds these Sets. `keySet` holds the lowercased
 * union of {@link DEFAULT_REDACT_KEYS} and `options.keys`; `paths` holds the
 * exact dot-paths. Build it via {@link compileRedactSpec} at boot (the Recorder
 * does this in its constructor) and feed it to {@link redactBoundedWith}.
 */
export interface CompiledRedactSpec {
  /** Lowercased union of default + configured keys, matched at any depth. */
  keySet: ReadonlySet<string>;
  /** Exact dot-paths to mask regardless of key name. */
  paths: ReadonlySet<string>;
}

/**
 * Precompiles the immutable key/path Sets from {@link RedactOptions}. Call once
 * (config is immutable after boot) and reuse the result across every entry —
 * this is the optimization that keeps the hottest redaction path allocation-free.
 */
export function compileRedactSpec(options: RedactOptions): CompiledRedactSpec {
  return {
    keySet: new Set(
      [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])].map((key) => key.toLowerCase()),
    ),
    paths: new Set(options.paths ?? []),
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Bounded, never-throwing, SYNCHRONOUS deep clone of `value` with sensitive
 * leaves masked. Same key/path masking semantics as {@link redact}, plus the
 * hard memory bounds in {@link RedactOptions} (all defaulted on). Returns the
 * clone AND whether truncation happened so the Recorder can surface a counter.
 *
 * Synchronicity is load-bearing: this is the detach that releases the host's
 * live object graph at `record()` time — never defer it (see spec §A.1).
 */
export function redactBounded(value: unknown, options: RedactOptions): RedactBoundedResult {
  // Ad-hoc callers compile the spec lazily here; the hot path (Recorder) passes
  // a prebuilt spec to redactBoundedWith() and skips this per-call allocation.
  return redactBoundedWith(value, options, compileRedactSpec(options));
}

/**
 * Bounded redaction using an ALREADY-COMPILED {@link CompiledRedactSpec}, so the
 * per-entry hot path never rebuilds the key/path Sets. Identical behaviour to
 * {@link redactBounded}; only the `keys`/`paths` of `options` are ignored in
 * favour of the prebuilt `spec` (the remaining bound options are still read).
 */
export function redactBoundedWith(
  value: unknown,
  options: RedactOptions,
  spec: CompiledRedactSpec,
): RedactBoundedResult {
  const mask = options.mask ?? '[REDACTED]';
  const keySet = spec.keySet;
  const paths = spec.paths;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const seen = new WeakSet<object>();

  // Mutable walk state: node + byte budgets and a truncation flag. Kept in the
  // closure (not threaded through args) so the per-call accounting stays cheap.
  let nodesRemaining = maxNodes;
  let bytesRemaining = maxContentBytes;
  let truncated = false;

  const walk = (node: unknown, path: string, depth: number): unknown => {
    // Every visited node (object, array, or leaf) costs one node unit and a
    // small byte overhead; strings additionally charge their length. Once either
    // budget is gone, prune the rest of the graph regardless of its shape.
    if (nodesRemaining <= 0 || bytesRemaining <= 0) {
      truncated = true;
      return SIZE_MARKER;
    }
    nodesRemaining -= 1;
    bytesRemaining -= NODE_BYTE_OVERHEAD;

    if (typeof node === 'string') {
      const kept = node.length > maxStringLength ? maxStringLength : node.length;
      bytesRemaining -= kept;
      if (node.length > maxStringLength) {
        truncated = true;
        return `${node.slice(0, maxStringLength)}${STRING_TRUNCATION_SUFFIX}`;
      }
      return node;
    }

    // `seen` tracks only the current ancestor path (added on the way down,
    // removed on the way up), so genuine cycles are caught while a non-cyclic
    // shared reference appearing in two sibling positions is NOT a false hit.
    if (Array.isArray(node)) {
      if (seen.has(node)) return '[Circular]';
      if (depth >= maxDepth) {
        truncated = true;
        return DEPTH_MARKER;
      }
      seen.add(node);
      const limit = Math.min(node.length, maxArrayLength);
      const mapped: unknown[] = [];
      for (let index = 0; index < limit; index++) {
        // Stop iterating the moment a budget runs out: ONE trailing marker, not
        // one marker per remaining item (markers themselves cost bytes).
        if (nodesRemaining <= 0 || bytesRemaining <= 0) {
          truncated = true;
          mapped.push(SIZE_MARKER);
          break;
        }
        mapped.push(walk(node[index], path ? `${path}.${index}` : String(index), depth + 1));
      }
      if (node.length > maxArrayLength) {
        truncated = true;
        mapped.push(`[Truncated: ${maxArrayLength} of ${node.length} items]`);
      }
      seen.delete(node);
      return mapped;
    }

    if (isPlainObject(node)) {
      if (seen.has(node)) return '[Circular]';
      if (depth >= maxDepth) {
        truncated = true;
        return DEPTH_MARKER;
      }
      seen.add(node);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        // Stop iterating the moment a budget runs out: ONE trailing marker, not
        // one marker per remaining field (keys + markers themselves cost bytes).
        if (nodesRemaining <= 0 || bytesRemaining <= 0) {
          truncated = true;
          result['…'] = SIZE_MARKER;
          break;
        }
        // Object keys are real serialized bytes — charge them too.
        bytesRemaining -= key.length;
        const childPath = path ? `${path}.${key}` : key;
        if (keySet.has(key.toLowerCase()) || paths.has(childPath)) {
          result[key] = mask;
        } else {
          result[key] = walk(child, childPath, depth + 1);
        }
      }
      seen.delete(node);
      return result;
    }

    return node;
  };

  return { value: walk(value, '', 0), truncated };
}

/**
 * Returns a deep clone of `value` with sensitive leaves replaced by the mask.
 * Never mutates the input. Memory-bounded by default (see {@link RedactOptions});
 * delegates to {@link redactBounded} and discards the truncation flag, so every
 * existing caller keeps the original `(value) => clone` signature.
 */
export function redact(value: unknown, options: RedactOptions): unknown {
  return redactBounded(value, options).value;
}
