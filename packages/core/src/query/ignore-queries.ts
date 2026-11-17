// packages/core/src/query/ignore-queries.ts
//
// Query noise filter: queries an app runs all the time and nobody reads (a workflow engine polling
// its runs table, a health check's `select 1`) are dropped before they are buffered, so they never
// cost a store write nor crowd the queries the console is for. The N+1 detector runs over what is
// kept, so ignoring a polling query cannot hide a real N+1 elsewhere.
import type { RecordInput } from '../entry/entry.js';

/**
 * One rule of `ignoreQueries`:
 * - a string matches when the sql CONTAINS it, case-insensitively and with runs of whitespace
 *   collapsed (so `'from durable_workflow_runs where id'` matches however the ORM laid it out);
 * - a RegExp is tested against the sql as recorded;
 * - a function gets the sql and the whole query content (`bindings`, `connection`…) and returns
 *   `true` to ignore it.
 */
export type QueryIgnoreRule =
  | string
  | RegExp
  | ((sql: string, content: Record<string, unknown>) => boolean);

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Compiles the rules into one predicate over a recorded input: `true` when it is a query one of
 * them matches. `null` without rules, so the recorder's hot path pays nothing. A rule that throws
 * keeps the query.
 */
export function compileQueryIgnore(
  rules: readonly QueryIgnoreRule[] | undefined,
): ((input: RecordInput) => boolean) | null {
  if (rules === undefined || rules.length === 0) return null;
  const needles = rules.filter((rule): rule is string => typeof rule === 'string').map(normalize);
  // Copied without the stateful flags: a `g`/`y` RegExp's `test` would resume from `lastIndex`,
  // and resetting it would throw on a frozen one.
  const patterns = rules
    .filter((rule): rule is RegExp => rule instanceof RegExp)
    .map((rule) => new RegExp(rule.source, rule.flags.replace(/[gy]/g, '')));
  const predicates = rules.filter(
    (rule): rule is (sql: string, content: Record<string, unknown>) => boolean =>
      typeof rule === 'function',
  );
  return (input) => {
    if (input.type !== 'query') return false;
    const content =
      typeof input.content === 'object' && input.content !== null
        ? (input.content as Record<string, unknown>)
        : null;
    const sql = typeof content?.sql === 'string' ? content.sql : null;
    if (content === null || sql === null) return false;
    if (needles.length > 0) {
      const normalized = normalize(sql);
      if (needles.some((needle) => needle !== '' && normalized.includes(needle))) return true;
    }
    for (const pattern of patterns) {
      if (pattern.test(sql)) return true;
    }
    for (const predicate of predicates) {
      try {
        if (predicate(sql, content)) return true;
      } catch {
        // A broken rule keeps the query.
      }
    }
    return false;
  };
}
