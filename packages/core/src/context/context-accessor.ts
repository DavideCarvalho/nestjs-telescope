// packages/core/src/context/context-accessor.ts

/**
 * Local, structural mirror of `@dudousxd/nestjs-context`'s public accessor
 * (`packages/core/src/accessor.ts`).
 *
 * Telescope deliberately does NOT import nestjs-context — it is an OPTIONAL peer.
 * Instead we declare the same shape here and inject it via the shared
 * {@link CONTEXT_ACCESSOR} token with `@Optional()`. Any object that structurally
 * satisfies this interface — including nestjs-context's real accessor — works.
 *
 * This is an ADDITIONAL, secondary correlation source layered ON TOP of the
 * existing OTel {@link TraceContextProvider}: when present it can supply a
 * fallback `traceId` (so Telescope entries correlate with durable/notifications
 * that share nestjs-context) plus the current user/tenant for grouping. It NEVER
 * clobbers an OTel trace id — see {@link RecorderOptions.contextAccessor} for the
 * precedence rules.
 *
 * Kept byte-aligned with nestjs-context's `ContextAccessor`: `traceId()` /
 * `tenantId()` are REQUIRED (the real accessor always provides them) and `get()`
 * is included, so the structural match stays exact.
 */
export interface ContextUserRef {
  type: string;
  id: string | number;
}

/** Opaque shape of the context store. Telescope never reads it; mirrors the upstream surface. */
export type ContextStore = Record<string, unknown>;

export interface ContextAccessor {
  /** Trace id for the current request, or `undefined` when unavailable. */
  traceId(): string | undefined;
  /** Current tenant id, or `undefined` when no multi-tenant context is populated. */
  tenantId(): string | undefined;
  /** Reference to the current user, or `undefined` when unauthenticated. */
  userRef(): ContextUserRef | undefined;
  /** The raw context store for the current request, or `undefined`. */
  get(): ContextStore | undefined;
}

/**
 * Cross-lib injection token for the current-request context accessor, owned by
 * `@dudousxd/nestjs-context`. We do NOT import nestjs-context — instead we share
 * its well-known token by value so DI resolves the same provider when present.
 *
 * `Symbol.for(key)` uses the global symbol registry, so this resolves to the
 * SAME symbol instance as nestjs-context's `tokens.ts` (and nestjs-authz's
 * mirror) without any import. The key MUST stay byte-identical with
 * nestjs-context's export.
 */
export const CONTEXT_ACCESSOR = Symbol.for('@dudousxd/nestjs-context:accessor');
