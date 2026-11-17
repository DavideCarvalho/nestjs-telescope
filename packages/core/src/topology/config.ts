// packages/core/src/topology/config.ts
//
// `topology` in `TelescopeModule.forRoot()`: one app on its own (the default), a control plane that
// stores the entries of several apps, or a tenant app that sends its entries to one.
import type { StorageProvider } from '../storage/storage-provider.js';
import type { TelescopeServerUrlSource } from './server-url.js';
import type { TenantTokenSource, TenantVerifier } from './tenant-auth.js';
import { type TenantTransport, httpTransport } from './transport.js';
import { isEntryId } from './wire.js';

export type TelescopeTopology = 'standalone' | 'control-plane' | 'tenant';

/** `tenant` in `TelescopeModule.forRoot()`, with `topology: 'tenant'`. */
export interface TelescopeTenantOptions {
  /**
   * The control plane's telescope URL (where its console is mounted, e.g.
   * `https://telescope.internal/telescope`). Shorthand for `transport: transports.http({ url })`.
   * A function (optionally with `refresh()`, e.g. a discovery source) is called on the first send,
   * not at boot; a failed lookup keeps the entries buffered and is tried again on the next send,
   * and a URL that stops answering is looked up again.
   */
  url?: TelescopeServerUrlSource;
  /** How batches reach the control plane. Default: HTTP to `url`. */
  transport?: TenantTransport;
  /**
   * The app this tenant is. Shown in the control plane's App picker. The control plane takes the
   * app from the verified token, so the token must be minted for this partition.
   */
  partition: string;
  /** The token presented with every batch: a string, or a function called before each send. */
  token: TenantTokenSource;
  /** Also keep entries in this store, for the app's own console. Default: none. */
  local?: StorageProvider;
  /**
   * This app relays entries for other apps (e.g. a workflow server recording events about its
   * tenant apps, tagged `app:<name>`). Its own entries (no `app:` tag) are then tagged
   * `app:<partition>`, on the wire and in `local`, and the ones tagged for another app are sent as
   * they are. The control plane stores them as that app (tagged `via:<partition>`) only when the
   * token carries `telescope:ingest:relay` (or `telescope:ingest:relay:<app>`); otherwise every
   * entry stays this app's, as without the option. Default `false`.
   */
  relay?: boolean;
  /** The most entries waiting to be sent (oldest dropped beyond). Default 10 000. */
  bufferSize?: number;
  /** The most entries per batch. Default 200. */
  batchSize?: number;
  /** The largest serialized batch in bytes. Default 64 000. */
  maxBatchBytes?: number;
  /** How often waiting entries are sent, in ms. Default 1 000. */
  intervalMs?: number;
}

export type ResolvedTopology =
  | { kind: 'standalone' }
  | {
      kind: 'control-plane';
      verifyTenant: TenantVerifier;
      /** A broker the control plane also consumes (its HTTP ingest route stays on). */
      transport: TenantTransport | undefined;
    }
  | {
      kind: 'tenant';
      transport: TenantTransport;
      partition: string;
      token: TenantTokenSource;
      options: TelescopeTenantOptions;
    };

interface TopologyInput {
  topology?: TelescopeTopology | undefined;
  verifyTenant?: TenantVerifier | undefined;
  tenant?: TelescopeTenantOptions | undefined;
  storage?: StorageProvider | undefined;
  transport?: TenantTransport | undefined;
}

/** The HTTP transport derived from a `tenant.url`, per `tenant` options object. */
const derivedTransports = new WeakMap<TelescopeTenantOptions, TenantTransport>();

/** Validates `topology` and its options; throws at boot on a mistake. */
export function resolveTopology(options: TopologyInput): ResolvedTopology {
  const topology = options.topology ?? 'standalone';
  if (topology === 'standalone') {
    if (options.tenant !== undefined) {
      throw new Error("telescope: `tenant` is set but `topology` is not 'tenant'.");
    }
    if (options.transport !== undefined) {
      throw new Error("telescope: `transport` is set but `topology` is not 'control-plane'.");
    }
    return { kind: 'standalone' };
  }
  if (topology === 'control-plane') {
    if (typeof options.verifyTenant !== 'function') {
      throw new Error(
        "telescope: `topology: 'control-plane'` needs `verifyTenant` (e.g. hmacTenantVerifier(secret)): without it any client could write as any app.",
      );
    }
    if (options.tenant !== undefined) {
      throw new Error("telescope: `tenant` is set but `topology` is 'control-plane'.");
    }
    if (options.transport !== undefined && typeof options.transport.listen !== 'function') {
      throw new Error(
        `telescope: transports.${options.transport.kind} has no consumer; a control plane always takes HTTP batches on its ingest route.`,
      );
    }
    return {
      kind: 'control-plane',
      verifyTenant: options.verifyTenant,
      transport: options.transport,
    };
  }
  if (topology !== 'tenant') {
    throw new Error(
      `telescope: unknown \`topology\` '${String(topology)}' (standalone, control-plane or tenant).`,
    );
  }
  const tenant = options.tenant;
  if (tenant === undefined) {
    throw new Error("telescope: `topology: 'tenant'` needs `tenant: { url, partition, token }`.");
  }
  if (!isEntryId(tenant.partition)) {
    throw new Error(
      'telescope: `tenant.partition` must be 1–255 printable ASCII characters, without spaces.',
    );
  }
  if (
    typeof tenant.token !== 'function' &&
    (typeof tenant.token !== 'string' || tenant.token === '')
  ) {
    throw new Error('telescope: `tenant.token` is empty; set it (e.g. from an env var).');
  }
  if (options.transport !== undefined) {
    throw new Error('telescope: on a tenant, set the transport as `tenant.transport`.');
  }
  if (tenant.relay !== undefined && typeof tenant.relay !== 'boolean') {
    throw new Error('telescope: `tenant.relay` must be a boolean.');
  }
  if (options.storage !== undefined) {
    throw new Error(
      "telescope: `topology: 'tenant'` ships entries to the control plane; use `tenant.local` (not `storage`) to keep a local copy.",
    );
  }
  if (
    tenant.transport === undefined &&
    typeof tenant.url !== 'function' &&
    (typeof tenant.url !== 'string' || tenant.url.trim() === '')
  ) {
    throw new Error('telescope: `tenant` needs `url` (or a `transport`).');
  }
  // One transport per `tenant` object: every resolution (the store, discovery) shares it, and so
  // shares one lookup of a lazy URL.
  let transport = tenant.transport ?? derivedTransports.get(tenant);
  if (transport === undefined) {
    transport = httpTransport({ url: tenant.url as TelescopeServerUrlSource });
    derivedTransports.set(tenant, transport);
  }
  return {
    kind: 'tenant',
    transport,
    partition: tenant.partition,
    token: tenant.token,
    options: tenant,
  };
}
