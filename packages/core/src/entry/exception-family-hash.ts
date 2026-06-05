// packages/core/src/entry/exception-family-hash.ts

/**
 * The grouping key for "the same error". Two occurrences share a family when
 * they have the same name, the same message, AND originate at the same top stack
 * frame — so a `TypeError: x is undefined` thrown from two unrelated call sites
 * stays two families, while the same bug recurring stays ONE. This is what the
 * dashboard's exception groupings and the `new-exception` alert dedup on, so it
 * must be deterministic across processes and across the server/browser sources.
 *
 * Why include the top frame: name+message alone over-groups (the same generic
 * message from different code paths collapses into one family) and a host that
 * embeds ids in messages would otherwise under-group; pinning to the first frame
 * is the pragmatic middle ground used by most error trackers.
 */
export interface ExceptionFamilyParts {
  /** Error class/name (e.g. `TypeError`); empty string when unknown. */
  name: string;
  /** Error message; empty string when unknown. */
  message: string;
  /** Full stack string, or `null` — only its FIRST frame contributes. */
  stack: string | null;
}

/**
 * Extract the first stack FRAME line (the deepest call site), skipping the
 * leading `Name: message` header that V8 and most browsers prepend. Returns an
 * empty string when no frame line is present, so the family key degrades to
 * name+message rather than throwing.
 */
function topStackFrame(stack: string | null): string {
  if (stack === null) return '';
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    // The first line is usually the `Error: message` header (no `at `). Frame
    // lines start with `at ` in V8; browsers vary, so also accept an `@`-form
    // (Firefox/Safari: `fn@url:line:col`). Take the first that looks like a frame.
    if (line.startsWith('at ') || line.includes('@')) {
      return line;
    }
  }
  return '';
}

/**
 * Build the stable family hash for an exception/client-error from its name,
 * message and top stack frame. Pure string concatenation (no hashing) keeps it
 * human-readable in the dashboard and trivially equal across the server
 * interceptor and the client-error controller, which both call this.
 */
export function exceptionFamilyHash(parts: ExceptionFamilyParts): string {
  const frame = topStackFrame(parts.stack);
  return `${parts.name}:${parts.message}:${frame}`;
}
