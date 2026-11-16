// packages/core/src/topology/ingest.ts
//
// The control plane's side of a tenant batch, whatever carried it (HTTP or a broker). It verifies
// the token, takes the app from it, validates the batch, drops what it already stored and stores
// the rest. It never throws: every outcome is a status the transport turns into an answer.
import type { Entry } from '../entry/entry.js';
import type { TenantVerifier, VerifiedTenant } from './tenant-auth.js';
import {
  APP_TAG_PREFIX,
  type WireEntry,
  fromWireEntry,
  isEntryId,
  parseIngestBatch,
} from './wire.js';

/** The capability a scoped token must carry to send entries. Tokens without capabilities may. */
export const TELESCOPE_INGEST_CAPABILITY = 'telescope:ingest';

/**
 * The capability a token needs to send entries on behalf of other apps: an entry tagged
 * `app:<name>` is stored as `<name>`'s, tagged `via:<sender>`. `telescope:ingest:relay:<name>`
 * allows that one app only, `telescope:*` every app. Implies {@link TELESCOPE_INGEST_CAPABILITY}.
 * Never implied by a token without capabilities: relaying must be granted explicitly.
 */
export const TELESCOPE_RELAY_CAPABILITY = 'telescope:ingest:relay';

/** An app name a relayer may name (`[A-Za-z0-9_.-]{1,64}`). */
const RELAY_APP = /^[A-Za-z0-9_.-]{1,64}$/;

/** The apps a token may relay for: every app (`'*'`), some, or none (`null`). */
export type RelayScope = '*' | string[] | null;

/** The apps `capabilities` may relay entries for. Absent capabilities relay for none. */
export function relayScope(capabilities: readonly string[] | undefined): RelayScope {
  if (capabilities === undefined) return null;
  if (capabilities.includes('telescope:*') || capabilities.includes(TELESCOPE_RELAY_CAPABILITY)) {
    return '*';
  }
  const prefix = `${TELESCOPE_RELAY_CAPABILITY}:`;
  const apps = capabilities
    .filter((capability) => capability.startsWith(prefix))
    .map((capability) => capability.slice(prefix.length))
    .filter((app) => RELAY_APP.test(app));
  return apps.length > 0 ? [...new Set(apps)] : null;
}

/** Whether a {@link RelayScope} allows relaying entries for `app`. */
export function canRelayFor(scope: RelayScope, app: string): boolean {
  return scope === '*' || scope?.includes(app) === true;
}

/**
 * Who a wire entry is stored for: the sender's own app, or (with relay rights) the app its own
 * `app:` tag names, then `relayed`. `null` when a relayer names an app it may not, an invalid one,
 * or several: such an entry is rejected, never stored as the sender's.
 */
function attribute(
  wire: WireEntry,
  sender: string,
  relay: RelayScope,
): { app: string; relayed: boolean } | null {
  // Without relay rights the sender's `app:` tags are dropped (as before): the token decides.
  if (relay === null) return { app: sender, relayed: false };
  const prefix = `${APP_TAG_PREFIX}:`;
  const named = [
    ...new Set(
      wire.tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length)),
    ),
  ];
  if (named.length > 1) return null;
  const target = named[0];
  if (target === undefined || target === sender) return { app: sender, relayed: false };
  if (!RELAY_APP.test(target) || !canRelayFor(relay, target)) return null;
  return { app: target, relayed: true };
}

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
  | {
      status: 'stored';
      app: string;
      stored: number;
      duplicate: number;
      /** Entries stored for another app on the sender's behalf (relay). */
      relayed: number;
      /** Entries refused one by one (a relay the token may not make); the rest is stored. */
      rejected: number;
      /** The apps entries were stored for: the sender's, and the ones it relayed for. */
      apps: string[];
    }
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
  /**
   * Takes the heartbeat a batch carries, for the verified `app` (never one named in the body).
   * Best effort: a throw is ignored and never refuses the batch.
   */
  heartbeat?(app: string, heartbeat: unknown): void | Promise<void>;
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

/** Whether `verified` may send entries (no capabilities listed: it may; relaying implies it). */
function canIngest(verified: VerifiedTenant): boolean {
  return (
    verified.capabilities === undefined ||
    verified.capabilities.includes(TELESCOPE_INGEST_CAPABILITY) ||
    relayScope(verified.capabilities) !== null
  );
}

/**
 * The control plane's batch handler. The app is the verified token's `tenant`, never anything in
 * the body; entries are tagged `app:<it>`, and an id is stored once per app (a redelivered batch,
 * or an entry the store already holds, stores nothing new). A token with relay rights
 * ({@link TELESCOPE_RELAY_CAPABILITY}) may store an entry for the app its `app:` tag names, tagged
 * `via:<sender>`.
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
    const relay = relayScope(verified.capabilities);
    const parsed = parseIngestBatch(body);
    if (!parsed.ok) return { status: 'invalid', reason: parsed.reason };
    if (parsed.batch.heartbeat !== undefined && options.heartbeat) {
      try {
        await options.heartbeat(app, parsed.batch.heartbeat);
      } catch {
        // The fleet is best effort; the entries are what the batch is for.
      }
    }
    const batchKey = `${app}\u0000${parsed.batch.id}`;
    if (batches.has(batchKey)) {
      return {
        status: 'stored',
        app,
        stored: 0,
        duplicate: parsed.batch.entries.length,
        relayed: 0,
        rejected: 0,
        apps: [],
      };
    }
    const at = now();
    const fresh: { entry: Entry; key: string; relayed: boolean }[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    for (const wire of parsed.batch.entries) {
      if (!isEntryId(wire.id)) return { status: 'invalid', reason: 'invalid entry id' };
      const owner = attribute(wire, app, relay);
      if (owner === null) {
        rejected += 1;
        continue;
      }
      const entry = fromWireEntry(wire, owner.app, at, owner.relayed ? app : undefined);
      if (entry === null) return { status: 'invalid', reason: 'invalid entry id' };
      // A relayed entry is deduped under its relayer and its app, so one relay's retry is deduped,
      // and it never collides with the app's own entries nor with another relay's. The parts are
      // joined on NUL, which no partition, app or id can contain.
      const key = owner.relayed
        ? `relay\u0000${app}\u0000${owner.app}\u0000${entry.id}`
        : `own\u0000${app}\u0000${entry.id}`;
      if (seen.has(entry.id) || entries.has(key)) continue;
      seen.add(entry.id);
      fresh.push({ entry, key, relayed: owner.relayed });
    }
    try {
      // An id the store already holds (this app's after a restart, or any other app's, relayed or
      // not) is kept as it is: a sender can never overwrite an entry.
      const held = fresh.length > 0 && options.existing ? await options.existing([...seen]) : null;
      const toStore = held === null ? fresh : fresh.filter(({ entry }) => !held.has(entry.id));
      if (toStore.length > 0) await options.store(toStore.map(({ entry }) => entry));
      batches.add(batchKey);
      for (const { key } of fresh) entries.add(key);
      const apps = new Set<string>();
      for (const { entry, relayed } of toStore) {
        if (!relayed) apps.add(app);
        else {
          const tag = entry.tags.find((t) => t.startsWith(`${APP_TAG_PREFIX}:`));
          if (tag !== undefined) apps.add(tag.slice(APP_TAG_PREFIX.length + 1));
        }
      }
      return {
        status: 'stored',
        app,
        stored: toStore.length,
        duplicate: parsed.batch.entries.length - toStore.length - rejected,
        relayed: toStore.filter(({ relayed }) => relayed).length,
        rejected,
        apps: [...apps],
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
