// packages/core/src/federation/config.ts
//
// `federation` in `TelescopeModule.forRoot()`: a central console that reads other apps' own
// telescope stores in place, instead of the apps shipping their entries to it.
import type { StorageProvider } from '../storage/storage-provider.js';
import { isEntryId } from '../topology/wire.js';

/** An app's store, or a function that builds it (called once, at boot). */
export type FederatedStorageSource =
  | StorageProvider
  | (() => StorageProvider | Promise<StorageProvider>);

/** One federated app: the store its own telescope writes, read by this console. */
export interface FederatedAppOptions {
  /**
   * The app's own telescope store, read in place (its entries never leave it): a provider, or a
   * function returning one. Point it at the app's database with a user that may only read it;
   * set the provider so it creates no schema (`MikroOrmStorageProvider`: `ensureSchema: false`), since
   * the app owns it.
   */
  storage: FederatedStorageSource;
  /** The App picker's label for it. Default: the app's name (`apps.labels` wins over this). */
  label?: string;
}

/** `federation` in `TelescopeModule.forRoot()`. */
export interface TelescopeFederationOptions {
  /**
   * The apps this console reads, by name (the `?app=` value and the `authorize` `apps` grant id):
   * 1–255 printable ASCII characters, without spaces, like a tenant's `partition`.
   */
  apps: Record<string, FederatedAppOptions>;
}

/** A validated federation: the apps in declaration order. */
export interface ResolvedFederation {
  apps: { name: string; storage: FederatedStorageSource; label: string | undefined }[];
}

function isStorageProvider(value: unknown): value is StorageProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StorageProvider).get === 'function' &&
    typeof (value as StorageProvider).find === 'function'
  );
}

/**
 * Validates `federation` (and how it combines with `topology`); throws at boot on a mistake.
 * `undefined` when it is not set.
 */
export function resolveFederation(options: {
  federation?: TelescopeFederationOptions | undefined;
  topology?: string | undefined;
}): ResolvedFederation | undefined {
  const federation = options.federation;
  if (federation === undefined) return undefined;
  if (options.topology === 'tenant') {
    throw new Error(
      "telescope: `federation` reads other apps' stores from a central console; a `topology: 'tenant'` app has no console store to add them to.",
    );
  }
  const apps = federation?.apps;
  if (typeof apps !== 'object' || apps === null || Array.isArray(apps)) {
    throw new Error('telescope: `federation.apps` must be an object of { [name]: { storage } }.');
  }
  const resolved: ResolvedFederation['apps'] = [];
  for (const [name, app] of Object.entries(apps)) {
    if (!isEntryId(name)) {
      throw new Error(
        `telescope: federated app name "${name}" must be 1–255 printable ASCII characters, without spaces.`,
      );
    }
    const storage = app?.storage;
    if (typeof storage !== 'function' && !isStorageProvider(storage)) {
      throw new Error(
        `telescope: \`federation.apps.${name}.storage\` must be a StorageProvider or a function returning one.`,
      );
    }
    if (app.label !== undefined && (typeof app.label !== 'string' || app.label === '')) {
      throw new Error(`telescope: \`federation.apps.${name}.label\` must be a non-empty string.`);
    }
    resolved.push({ name, storage, label: app.label });
  }
  if (resolved.length === 0) {
    throw new Error('telescope: `federation.apps` names no app.');
  }
  return { apps: resolved };
}

/** The federated app names of `options` (none: `undefined`), without validating the rest. */
export function federatedAppNames(
  federation: TelescopeFederationOptions | undefined,
): string[] | undefined {
  if (federation === undefined || typeof federation?.apps !== 'object') return undefined;
  const names = Object.keys(federation.apps ?? {});
  return names.length > 0 ? names : undefined;
}
