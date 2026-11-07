// packages/official/src/read.ts

/**
 * Structural readers for the official packages' payloads. They are 0.x and their shapes churn, so
 * nothing here imports their types: every field is optional and type-checked, an unknown field is
 * ignored, and a missing one yields `undefined`, never a throw.
 */

export type Rec = Record<string, unknown>;

export function asRecord(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Copy the listed fields whose value passes `read`, skipping the absent ones. */
export function pick<T>(source: Rec, keys: readonly string[], read: (v: unknown) => T | undefined) {
  const out: Rec = {};
  for (const key of keys) {
    const value = read(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const MESSAGE_LIMIT = 1000;

/**
 * An error as a small plain object: `name`, `message` and (when present) `code`. `@nestjs/workflows`
 * already hands a serialized error (`{ name, message, stack?, compensation? }`); a thrown `Error` or
 * anything else is reduced the same way. Stacks are dropped: an event entry is an audit line, and
 * the exception watcher already records the stack where the throw reached the app.
 */
export function readError(value: unknown): Rec | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return { message: String(value).slice(0, MESSAGE_LIMIT) };
  const e = value as Rec;
  const out: Rec = {};
  const name = str(e.name);
  const message = str(e.message);
  if (name !== undefined) out.name = name;
  if (message !== undefined) out.message = message.slice(0, MESSAGE_LIMIT);
  const code = e.code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  const compensation = readError(e.compensation);
  if (compensation !== null) out.compensation = compensation;
  return out;
}
