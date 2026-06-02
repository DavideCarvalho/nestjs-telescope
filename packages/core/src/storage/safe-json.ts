// packages/core/src/storage/safe-json.ts

/** Parse JSON, returning `fallback` on any error. */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
