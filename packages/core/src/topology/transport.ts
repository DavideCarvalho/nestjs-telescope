// packages/core/src/topology/transport.ts
//
// How a tenant's batches reach the control plane. HTTP is the default; broker drivers carry the
// same batch in an envelope with the token.
import type { IngestHandler } from './ingest.js';
import { ServerUrl, type TelescopeServerUrlSource, assertServerUrlSource } from './server-url.js';
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
   * `https://telescope.internal/telescope`). Batches go to `POST <url>/api/ingest`. A function
   * (optionally with `refresh()`) is looked up on the first send, not at boot, and again when the
   * URL stops answering; a {@link ServerUrl} shares one lookup with discovery.
   */
  url: TelescopeServerUrlSource | ServerUrl;
  /** The `fetch` to use. Default: the global one. */
  fetch?: typeof fetch;
  /** Abort a send after this long; it is retried. Default 10 000 ms. */
  timeoutMs?: number;
}

/** The ingest endpoint under a control plane's telescope URL. */
export function ingestUrl(url: string): string {
  return `${url.replace(/\/+$/, '')}/api/ingest`;
}

/** A transport's {@link ServerUrl}, when it sends over HTTP to one. */
export const SERVER_URL = Symbol.for('@dudousxd/nestjs-telescope:serverUrl');

/**
 * Sends each batch as `POST <url>/api/ingest` with `Authorization: Bearer <token>`. With a looked-up
 * URL, a failed lookup is a `retry` (the batch stays buffered), and a send that cannot connect or
 * gets a 404 looks the URL up again and, when it moved, sends once more to the new one.
 */
export function httpTransport(
  options: HttpTransportOptions,
): TenantTransport & { [SERVER_URL]: ServerUrl } {
  const url = options.url;
  if (!(url instanceof ServerUrl)) assertServerUrlSource(url, 'transports.http `url`');
  const server = url instanceof ServerUrl ? url : new ServerUrl(url);
  const timeoutMs = options.timeoutMs ?? 10_000;

  const post = async (
    endpoint: string,
    batch: IngestBatch,
    token: string,
  ): Promise<{ result: SendResult; moved: boolean }> => {
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
        result: {
          status: 'retry',
          reason: `POST ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        moved: true,
      };
    }
    // The body is not needed; release the connection.
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return { result: { status: 'sent' }, moved: false };
    const reason = `POST ${endpoint} answered ${response.status}`;
    // 400 (malformed) and 413 (too large) never succeed; everything else may (401: the token may
    // be re-minted; 404: the control plane may not be up yet, or it moved; 5xx).
    if (response.status === 400 || response.status === 413) {
      return { result: { status: 'drop', reason }, moved: false };
    }
    return { result: { status: 'retry', reason }, moved: response.status === 404 };
  };

  return {
    kind: 'http',
    [SERVER_URL]: server,
    async send(batch, { token }) {
      let base: string;
      try {
        base = await server.get();
      } catch (error) {
        return {
          status: 'retry',
          reason: `cannot resolve the control plane URL: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const first = await post(ingestUrl(base), batch, token);
      if (!first.moved || !server.lazy) return first.result;
      // Unreachable, or not a telescope there: look the URL up again, and resend once if it moved.
      let next: string;
      try {
        next = await server.refresh();
      } catch {
        return first.result;
      }
      if (next === base) return first.result;
      return (await post(ingestUrl(next), batch, token)).result;
    },
  };
}
