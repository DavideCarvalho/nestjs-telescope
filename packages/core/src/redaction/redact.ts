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
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Returns a deep clone of `value` with sensitive leaves replaced by the mask.
 * Never mutates the input.
 */
export function redact(value: unknown, options: RedactOptions): unknown {
  const mask = options.mask ?? '[REDACTED]';
  const keySet = new Set(
    [...DEFAULT_REDACT_KEYS, ...(options.keys ?? [])].map((key) => key.toLowerCase()),
  );
  const paths = new Set(options.paths ?? []);
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): unknown => {
    // `seen` tracks only the current ancestor path (added on the way down,
    // removed on the way up), so genuine cycles are caught while a non-cyclic
    // shared reference appearing in two sibling positions is NOT a false hit.
    if (Array.isArray(node)) {
      if (seen.has(node)) return '[Circular]';
      seen.add(node);
      const mapped = node.map((item, index) =>
        walk(item, path ? `${path}.${index}` : String(index)),
      );
      seen.delete(node);
      return mapped;
    }
    if (isPlainObject(node)) {
      if (seen.has(node)) return '[Circular]';
      seen.add(node);
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (keySet.has(key.toLowerCase()) || paths.has(childPath)) {
          result[key] = mask;
        } else {
          result[key] = walk(child, childPath);
        }
      }
      seen.delete(node);
      return result;
    }
    return node;
  };

  return walk(value, '');
}
