// integration/memory-soak/src/config.ts
//
// The soak configuration: the incident "full" config plus per-component toggles
// used to BISECT the leak. Each cell flips exactly one knob off the full config
// so a flattened slope names the responsible component.

export type StorageKind = 'in-memory' | 'sqlite' | 'slow-storage';

export interface SoakConfig {
  /** Human label for the table row. */
  label: string;
  /** Which storage provider to wire. */
  storage: StorageKind;
  /** Whether the request middleware captures the FAT circular `req.user`. */
  fatUser: boolean;
  /** Cache hit/miss emits fired per request via the custom `instrument`. */
  cacheEmitsPerRequest: number;
  /** Query `record()`s emitted per request (MikroORM-logger-shaped content). */
  queryRecordsPerRequest: number;
  /** Whether the exception watcher path fires (a fraction of requests throw). */
  exceptions: boolean;
  /** Whether a real OTel NodeSDK + http instrumentation + dead OTLP export runs. */
  otel: boolean;
  /** Whether prune is configured (short interval). */
  prune: boolean;
  /**
   * Whether the rollup SPI is active. The lib's stores implement it
   * unconditionally; to toggle it off we wrap the store to hide
   * recordRollups/queryRollups so `isRollupStore` returns false.
   */
  rollups: boolean;
}

/** The full incident-mimicking configuration (the leaking baseline). */
export const FULL_CONFIG: SoakConfig = {
  label: 'full (incident)',
  storage: 'slow-storage',
  fatUser: true,
  cacheEmitsPerRequest: 8,
  queryRecordsPerRequest: 5,
  exceptions: true,
  otel: true,
  prune: true,
  rollups: true,
};

/** Build the bisection matrix: full config, then one knob removed per cell. */
export function buildMatrix(): SoakConfig[] {
  return [
    FULL_CONFIG,
    { ...FULL_CONFIG, label: 'no fat user', fatUser: false },
    { ...FULL_CONFIG, label: 'no cache spam', cacheEmitsPerRequest: 0 },
    { ...FULL_CONFIG, label: 'no query records', queryRecordsPerRequest: 0 },
    { ...FULL_CONFIG, label: 'no otel', otel: false },
    { ...FULL_CONFIG, label: 'storage=in-memory', storage: 'in-memory' },
    { ...FULL_CONFIG, label: 'storage=sqlite', storage: 'sqlite' },
    { ...FULL_CONFIG, label: 'no prune', prune: false },
    { ...FULL_CONFIG, label: 'no rollups', rollups: false },
  ];
}

export interface RunOptions {
  /** Warm-up window before sampling starts, ms. */
  warmupMs: number;
  /** Sustained measured window, ms. */
  durationMs: number;
  /** Sampling cadence (gc + heapUsed read), ms. */
  sampleIntervalMs: number;
  /** Target in-process request concurrency (keep-alive sockets in flight). */
  concurrency: number;
  /** PASS/FAIL threshold on the post-warmup slope, bytes/min. */
  thresholdBytesPerMin: number;
  /** When set, write a heap snapshot for the run to this path for retainer analysis. */
  heapSnapshotPath?: string;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  warmupMs: 30_000,
  durationMs: 180_000,
  sampleIntervalMs: 10_000,
  concurrency: 24,
  // 25 MB/min sustained growth over a 3-min window is unmistakably a leak; churn
  // settles well under this once GC runs each sample.
  thresholdBytesPerMin: 25 * 1024 * 1024,
};

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Run options overridable via env so the same harness scales from CI to long soaks. */
export function resolveRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    warmupMs: readIntEnv('SOAK_WARMUP_MS', DEFAULT_RUN_OPTIONS.warmupMs),
    durationMs: readIntEnv('SOAK_DURATION_MS', DEFAULT_RUN_OPTIONS.durationMs),
    sampleIntervalMs: readIntEnv('SOAK_SAMPLE_MS', DEFAULT_RUN_OPTIONS.sampleIntervalMs),
    concurrency: readIntEnv('SOAK_CONCURRENCY', DEFAULT_RUN_OPTIONS.concurrency),
    thresholdBytesPerMin: readIntEnv(
      'SOAK_THRESHOLD_BYTES_PER_MIN',
      DEFAULT_RUN_OPTIONS.thresholdBytesPerMin,
    ),
    ...overrides,
  };
}

/**
 * Select which matrix cells to run. `SOAK_CELLS` is a comma-separated list of
 * substrings matched against the cell label (e.g. `SOAK_CELLS=full,no fat`).
 * Defaults to the full matrix.
 */
export function selectCells(matrix: SoakConfig[]): SoakConfig[] {
  const raw = process.env.SOAK_CELLS;
  if (raw === undefined || raw.trim() === '') return matrix;
  const wanted = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const selected = matrix.filter((cell) =>
    wanted.some((needle) => cell.label.toLowerCase().includes(needle)),
  );
  return selected.length > 0 ? selected : matrix;
}
