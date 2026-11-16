// packages/core/src/topology/transport.ts
//
// How a tenant's batches reach the control plane. HTTP is the default; broker drivers carry the
// same batch in an envelope with the token.
import type { IngestBatch } from './wire.js';

/**
 * What became of one send.
 * - `sent`: the control plane has the batch (stored, or a duplicate of one it stored).
 * - `retry`: try again later (the control plane or the broker is down, or the token was refused
 *   and may be re-minted). The batch stays at the head of the buffer.
 * - `drop`: the batch can never be accepted (malformed, too large). It is dropped and counted.
 */
export type SendResult = { status: 'sent' } | { status: 'retry' | 'drop'; reason: string };

/** The tenant side of a transport. */
export interface TenantTransport {
  /** `http`, or the broker's name, for logs and status. */
  readonly kind: string;
  send(batch: IngestBatch, credentials: { token: string; partition: string }): Promise<SendResult>;
  /** Releases connections at shutdown, after the last send. */
  close?(): Promise<void>;
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

/** The transport drivers. Each `tenant` and its control plane choose one. */
export const transports = {
  http: httpTransport,
};
