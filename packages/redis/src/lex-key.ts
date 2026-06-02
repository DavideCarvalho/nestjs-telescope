/**
 * Lexicographic key codec for newest-first keyset pagination over Redis ZSETs.
 *
 * Each index member is a single total-order lex key `inv(createdAtMs):id` where
 * `inv = (MAX_MS - createdAtMs)` zero-padded to a fixed width, so the newest
 * entry sorts lexicographically smallest. Index ZSETs use score 0 and these
 * members, and pagination is plain `ZRANGEBYLEX` (ascending = newest-first).
 *
 * WIDTH=15 / MAX_MS=999_999_999_999_999 keeps the inverse arithmetic exact:
 * MAX_MS = 10**15 - 1 < Number.MAX_SAFE_INTEGER (9_007_199_254_740_991), and
 * real timestamps (Date.now() ~ 1.7e12) are far below 1e15, so the padded
 * width never overflows and subtraction stays a clean integer.
 */
const WIDTH = 15;
const MAX_MS = 999_999_999_999_999;

/** Newest-first lex member: smaller createdAt-inverse sorts first. */
export function lexMember(createdAtMs: number, id: string): string {
  return `${invBound(createdAtMs)}:${id}`;
}

/**
 * Zero-padded inverse of a timestamp; the prefix every member for that
 * `createdAtMs` shares. Monotonic decreasing in `createdAtMs` (newer → smaller),
 * so it doubles as a `ZRANGEBYLEX` bound for `before`/`after` windows.
 */
export function invBound(createdAtMs: number): string {
  return (MAX_MS - createdAtMs).toString().padStart(WIDTH, '0');
}

/** Extract the id from a member: everything after the first `:` (ids may contain `:`). */
export function idFromMember(member: string): string {
  return member.slice(member.indexOf(':') + 1);
}
