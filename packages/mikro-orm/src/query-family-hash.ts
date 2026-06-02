// packages/mikro-orm/src/query-family-hash.ts

/** Normalize an SQL string into a template: lowercase, collapse whitespace,
 *  replace string/number literals and bound-param placeholders with '?'. */
function normalizeSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/'(?:[^']|'')*'/g, '?') // string literals
    .replace(/\b\d+(?:\.\d+)?\b/g, '?') // numeric literals
    .replace(/\?/g, '?') // already-parameterized (no-op, keeps idempotency explicit)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable 32-bit FNV-1a hash, hex-encoded. Deterministic across processes. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Grouping key for "the same query" — same template, any bound values. */
export function queryFamilyHash(sql: string): string {
  return fnv1a(normalizeSql(sql));
}
