// packages/core/src/topology/ingest.ts
//
// The control plane's side of a tenant batch, whatever carried it (HTTP or a broker). It verifies
// the token, takes the app from it, validates the batch, drops what it already stored and stores
// the rest. It never throws: every outcome is a status the transport turns into an answer.
import type { Entry } from '../entry/entry.js';
import type { TenantVerifier, VerifiedTenant } from './tenant-auth.js';
import { fromWireEntry, isEntryId, parseIngestBatch } from './wire.js';

/** The capability a scoped token must carry to send entries. Tokens without capabilities may. */
export const TELESCOPE_INGEST_CAPABILITY = 'telescope:ingest';

/** How many `<partition>:<id>` keys the dedupe remembers, per kind (batches, entries). */
const DEFAULT_DEDUPE_SIZE = 50_000;

/**
 * What became of a batch.
 * - `stored`: stored (or already stored before: `duplicate` counts those entries).
 * - `unauthenticated` / `forbidden`: the token was refused, or lacks the capability. Not retried by
 *   a broker transport (dead-lettered); an HTTP tenant retries, since its token may be re-minted.
 * - `invalid`: the batch is malformed. Never retried (dead-lettered).
 * - `unavailable`: the verifier or the store failed. Retried.
 */
export type IngestOutcome =
  | { status: 'stored'; app: string; stored: number; duplicate: number }
  | { status: 'unauthenticated' }
  | { status: 'forbidden'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'unavailable'; reason: string };

/** What a delivery of a batch carries. `body` is untrusted: it is validated here. */
export interface IngestDelivery {
  token: string | undefined;
  body: unknown;
}

export interface IngestHandlerOptions {
  verifyTenant: TenantVerifier;
  /** Stores entries; the handler answers `stored` only once this resolves. */
  store(entries: Entry[]): Promise<void>;
  /** The ids among `ids` the store already holds (a redelivery after a restart). */
  existing?(ids: string[]): Promise<Set<string>>;
  /** Default 50 000 per kind. */
  dedupeSize?: number;
  now?: () => number;
}

export type IngestHandler = (delivery: IngestDelivery) => Promise<IngestOutcome>;

/** A bounded set that forgets its oldest keys first. */
class BoundedSet {
  readonly #keys = new Set<string>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.#keys.has(key);
  }
  add(key: string): void {
    this.#keys.delete(key);
    this.#keys.add(key);
    while (this.#keys.size > this.max) {
      const oldest = this.#keys.values().next().value;
      if (oldest === undefined) break;
      this.#keys.delete(oldest);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `verified` may send entries (no capabilities listed: it may). */
function canIngest(verified: VerifiedTenant): boolean {
  return (
    verified.capabilities === undefined ||
    verified.capabilities.includes(TELESCOPE_INGEST_CAPABILITY)
  );
}

/**
 * The control plane's batch handler. The app is the verified token's `tenant`, never anything in
 * the body; entries are tagged `app:<it>`, and an id is stored once per app (a redelivered batch,
 * or an entry the store already holds, stores nothing new).
 */
export function createIngestHandler(options: IngestHandlerOptions): IngestHandler {
  const now = options.now ?? Date.now;
  const size = options.dedupeSize ?? DEFAULT_DEDUPE_SIZE;
  const batches = new BoundedSet(size);
  const entries = new BoundedSet(size);
  return async ({ token, body }) => {
    let verified: VerifiedTenant | null;
    try {
      verified =
        typeof token === 'string' && token.length > 0
          ? await options.verifyTenant({ token })
          : null;
    } catch (error) {
      return { status: 'unavailable', reason: `verifyTenant threw: ${message(error)}` };
    }
    if (verified === null || !isEntryId(verified.tenant)) return { status: 'unauthenticated' };
    if (!canIngest(verified)) {
      return { status: 'forbidden', reason: `token lacks ${TELESCOPE_INGEST_CAPABILITY}` };
    }
    const app = verified.tenant;
    const parsed = parseIngestBatch(body);
    if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
    const batchKey = `${app}:${parsed.batch.id}`;
    if (batches.has(batchKey)) {
      return { status: 'stored', app, stored: 0, duplicate: parsed.batch.entries.length };
    }
    const at = now();
    const fresh: Entry[] = [];
    const seen = new Set<string>();
    for (const wire of parsed.batch.entries) {
      const entry = fromWireEntry(wire, app, at);
      if (entry === null) return { status: 'invalid', reason: 'invalid entry id' };
      if (seen.has(entry.id) || entries.has(`${app}:${entry.id}`)) continue;
      seen.add(entry.id);
      fresh.push(entry);
    }
    try {
      // An id the store already holds (this app's after a restart, or any other app's) is kept as
      // it is: a sender can never overwrite an entry.
      const held = fresh.length > 0 && options.existing ? await options.existing([...seen]) : null;
      const toStore = held === null ? fresh : fresh.filter((entry) => !held.has(entry.id));
      if (toStore.length > 0) await options.store(toStore);
      batches.add(batchKey);
      for (const entry of fresh) entries.add(`${app}:${entry.id}`);
      return {
        status: 'stored',
        app,
        stored: toStore.length,
        duplicate: parsed.batch.entries.length - toStore.length,
      };
    } catch (error) {
      return { status: 'unavailable', reason: `store failed: ${message(error)}` };
    }
  };
}

/** The HTTP status of an outcome. */
export function ingestHttpStatus(outcome: IngestOutcome): number {
  switch (outcome.status) {
    case 'stored':
      return 202;
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'invalid':
      return 400;
    case 'unavailable':
      return 503;
  }
}
