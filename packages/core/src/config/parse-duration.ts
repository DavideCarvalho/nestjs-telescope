// packages/core/src/config/parse-duration.ts

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Convert a duration (raw ms number, or `<int><ms|s|m|h|d>` string) to ms.
 *  Throws on an unparseable string. */
export function durationToMs(duration: number | string): number {
  if (typeof duration === 'number') {
    return duration;
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  const unit = match[2] as keyof typeof DURATION_UNITS;
  return Number(match[1]) * DURATION_UNITS[unit]!;
}
