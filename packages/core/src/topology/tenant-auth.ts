// packages/core/src/topology/tenant-auth.ts
//
// The tenant contract of Aviary's central servers, copied from @dudousxd/nestjs-durable
// (`packages/core/src/tenant-auth.ts`) so telescope depends on nothing for it. Same names, same
// token format: a durable `signTenantToken` token verifies here and the other way round.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tenant auth for a telescope control plane. A tenant app ships its entries with a token; the
 * control plane's {@link TenantVerifier} derives the app (its partition) from that token and never
 * from the request body, so a tenant cannot write as another app.
 *
 * The built-in token is `<claim>.<base64url(HMAC-SHA256(secret, claim))>`, where `claim` is the
 * partition, optionally followed by `.exp<epochMs>` (the same format as durable's and Agora's).
 * HMAC (a shared secret) is the zero-infra default; a deployment with an identity provider supplies
 * its own {@link TenantVerifier} instead.
 */

/** The identity a {@link TenantVerifier} derives from a tenant's signed claim. */
export interface VerifiedTenant {
  /** The partition (app) the token authenticates as. The control plane trusts THIS, never the body. */
  tenant: string;
  /**
   * Capabilities the token grants, if the issuer scopes them. Absent: every capability. Present: the
   * control plane takes entries only when it lists `telescope:ingest`
   * ({@link import('./ingest.js').TELESCOPE_INGEST_CAPABILITY}).
   */
  capabilities?: string[] | undefined;
}

/**
 * Verifies a tenant's token on the **control plane**, returning the {@link VerifiedTenant} it
 * authenticates as, or `null` to reject a tampered, invalid, expired or absent token. A throw means
 * the verifier itself is down (an identity provider timing out): the batch is retried, not dropped.
 * `tenant` is the partition the sender claims, advisory only.
 */
export type TenantVerifier = (input: {
  /** The signed token presented on the request. */
  token?: string | undefined;
  /** The tenant the request *claims* to be. Advisory only: the verifier derives the real one. */
  tenant?: string | undefined;
}) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/**
 * Where the tenant side gets the token it presents: a static string, or a function called before
 * every request (so a short-lived token from {@link signTenantToken} with `ttlMs` can be re-minted
 * or fetched from a secret store without restarting the app).
 */
export type TenantTokenSource = string | (() => string | Promise<string>);

/** Separator between the claim and its signature. `.` never appears in base64url, so the LAST `.`
 *  splits the two halves unambiguously, and a tenant name may itself contain dots. */
const TOKEN_SEP = '.';

/** The trailing expiry marker an expiring token's claim carries (see {@link signTenantToken}). */
const EXP_SUFFIX = /\.exp(\d+)$/;

/** The HMAC digest that authenticates `claim` under `secret`. */
function sign(claim: string, secret: string): string {
  return createHmac('sha256', secret).update(claim).digest('base64url');
}

/**
 * Mint the signed token a tenant app presents:
 * `` `${tenant}.${base64url(HMAC-SHA256(secret, tenant))}` ``. The app carries only the token
 * (never the secret); the control plane verifies it with the SAME `secret` via {@link hmacTenantVerifier}.
 */
export function signTenantToken(
  tenant: string,
  secret: string,
  opts?: {
    /**
     * Optional lifetime: the claim gains a `.exp<epochMs>` suffix, signed together with the tenant,
     * and {@link hmacTenantVerifier} rejects the token once that instant passes. Without it the
     * token never expires. Expiring and non-expiring tokens verify side by side. Tenant names
     * ending in `.exp<digits>` are reserved by this scheme.
     */
    ttlMs?: number;
    /** Injectable clock for tests. */
    now?: number;
  },
): string {
  const claim =
    opts?.ttlMs !== undefined
      ? `${tenant}${TOKEN_SEP}exp${(opts.now ?? Date.now()) + opts.ttlMs}`
      : tenant;
  return `${claim}${TOKEN_SEP}${sign(claim, secret)}`;
}

/**
 * Build the control plane's {@link TenantVerifier} for {@link signTenantToken} tokens under `secret`.
 * It recomputes the HMAC over the embedded claim and compares it in constant time, so a tampered
 * tenant, a forged/absent signature, a token signed with another secret, or an expired token all
 * return `null`. The tenant is DERIVED from the token's own claim.
 *
 * A LIST of secrets makes rotation a two-step deploy: verify with `[next, current]` everywhere first,
 * then re-mint tenant tokens with `next` at leisure. `capabilities`, if given, is a static grant
 * stamped onto every {@link VerifiedTenant} this verifier authenticates.
 */
export function hmacTenantVerifier(
  secret: string | string[],
  capabilities?: string[],
): TenantVerifier {
  const secrets = Array.isArray(secret) ? secret : [secret];
  return ({ token }): VerifiedTenant | null => {
    if (typeof token !== 'string' || token.length === 0) return null;
    const sep = token.lastIndexOf(TOKEN_SEP);
    if (sep <= 0 || sep === token.length - 1) return null; // no claim or no signature half
    const claim = token.slice(0, sep);
    const presented = token.slice(sep + 1);
    if (!secrets.some((s) => constantTimeEquals(presented, sign(claim, s)))) return null;
    // The expiry suffix is INSIDE the signature, so it can be neither stripped nor extended.
    const exp = EXP_SUFFIX.exec(claim);
    if (exp) {
      const expiresAt = Number(exp[1]);
      if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
      const tenant = claim.slice(0, claim.length - (exp[0]?.length ?? 0));
      if (tenant.length === 0) return null;
      return capabilities !== undefined ? { tenant, capabilities } : { tenant };
    }
    return capabilities !== undefined ? { tenant: claim, capabilities } : { tenant: claim };
  };
}

/** Resolve a {@link TenantTokenSource} to the token string to put on the wire. */
export async function resolveTenantToken(source: TenantTokenSource): Promise<string> {
  return typeof source === 'function' ? source() : source;
}

/** Constant-time compare that never throws on a length mismatch. */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
