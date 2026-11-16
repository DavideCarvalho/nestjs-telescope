// packages/core/src/topology/transport.ts
//
// How a tenant's batches reach the control plane. HTTP is the default; broker drivers carry the
// same batch in an envelope with the token.
import type { IngestHandler } from './ingest.js';
import type { IngestBatch } from './wire.js';

/**
 * What became of one send.
 * - `sent`: the control plane has the batch (stored, or a duplicate of one it stored).
 * - `retry`: try again later (the control plane or the broker is down, or the token was refused
 *   and may be re-minted). The batch stays at the head of the buffer.
 * - `drop`: the batch can never be accepted (malformed, too large). It is dropped and counted.
 */
export type SendResult = { status: 'sent' } | { status: 'retry' | 'drop'; reason: string };

/** Where a broker consumer reports what it refused. */
export interface TransportLogger {
  warn(message: string): void;
}

/** A running broker consumer on the control plane. */
export interface TransportListener {
  /** Stops taking messages; resolves once the one being handled is done. */
  stop(): Promise<void>;
}

/**
 * A transport: the tenant side sends, the control plane side (brokers only) consumes. The same
 * driver is configured on both: `tenant.transport` on a tenant, `transport` on the control plane.
 */
export interface TenantTransport {
  /** `http`, or the broker's name, for logs and status. */
  readonly kind: string;
  send(batch: IngestBatch, credentials: { token: string; partition: string }): Promise<SendResult>;
  /**
   * Control plane: consume the broker's messages, handing each to `handler` (which verifies the
   * token, dedupes and stores). Acknowledge `stored`; dead-letter `invalid`, `unauthenticated` and
   * `forbidden` (a message's token never changes); leave `unavailable` for a retry, dead-lettered
   * after the driver's attempts. HTTP has no consumer: tenants post to the ingest route.
   */
  listen?(handler: IngestHandler, logger: TransportLogger): Promise<TransportListener>;
  /** Releases connections at shutdown, after the last send. */
  close?(): Promise<void>;
}

/** Any transport driver. */
export type TelescopeTransport = TenantTransport;

/** Whether an ingest outcome must never be retried from a broker (it is dead-lettered). */
export function isDeadLetter(status: string): boolean {
  return status === 'invalid' || status === 'unauthenticated' || status === 'forbidden';
}

/**
 * Imports an optional peer by a variable specifier, so bundlers and the type checker never require
 * it unless the driver is selected.
 */
export async function importPeer<T>(name: string, driver: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch (error) {
    throw new Error(
      `telescope transports.${driver} needs \`${name}\` installed (npm i ${name}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Options of {@link httpTransport}. */
export interface HttpTransportOptions {
  /**
   * The control plane's telescope URL: where its console is mounted (e.g.
   * `https://telescope.internal/telescope`). Batches go to `POST <url>/api/ingest`.
   */
  url: string;
  /** The `fetch` to use. Default: the global one. */
  fetch?: typeof fetch;
  /** Abort a send after this long; it is retried. Default 10 000 ms. */
  timeoutMs?: number;
}

/** The ingest endpoint under a control plane's telescope URL. */
export function ingestUrl(url: string): string {
  return `${url.replace(/\/+$/, '')}/api/ingest`;
}

/** Sends each batch as `POST <url>/api/ingest` with `Authorization: Bearer <token>`. */
export function httpTransport(options: HttpTransportOptions): TenantTransport {
  if (typeof options.url !== 'string' || options.url.trim() === '') {
    throw new Error('telescope transports.http: `url` is required.');
  }
  const endpoint = ingestUrl(options.url.trim());
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    kind: 'http',
    async send(batch, { token }) {
      const doFetch = options.fetch ?? globalThis.fetch;
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return {
          status: 'retry',
          reason: `POST ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // The body is not needed; release the connection.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { status: 'sent' };
      const reason = `POST ${endpoint} answered ${response.status}`;
      // 400 (malformed) and 413 (too large) never succeed; everything else may (401: the token may
      // be re-minted; 404: the control plane may not be up yet; 5xx).
      if (response.status === 400 || response.status === 413) return { status: 'drop', reason };
      return { status: 'retry', reason };
    },
  };
}
