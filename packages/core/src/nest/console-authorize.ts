// packages/core/src/nest/console-authorize.ts
//
// The console access contract every Aviary console declares locally with
// identical names and shapes (no cross-lib import): the `authorize` option,
// its resolver and `authorizeByToken`.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExecutionContext, Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** Class form: an `@Injectable()` provider (constructor injection works). */
export interface ConsoleAuthorizer {
  authorize(context: ExecutionContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}
export type ConsoleAuthorizerClass = Type<ConsoleAuthorizer>;

/** An `@nestjs/authorization` policy check: `policy[ability](user)`. */
export interface ConsolePolicyCheck {
  policy: Type<unknown>;
  ability: string;
}

export type ConsoleAuthorize =
  | ((context: ExecutionContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>) // inline
  | ConsoleAuthorizerClass // class
  | (() => Promise<{ default: ConsoleAuthorizerClass }>) // lazy import
  | ConsolePolicyCheck // official policy
  | string; // registered gate name

export type ConsoleDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** What a resolved `authorize` is: called once per request, never throws. */
export type ConsoleDecide = (context: ExecutionContext) => Promise<ConsoleDecision>;

/**
 * The provider `@dudousxd/nestjs-authz` registers to resolve gate names (`authorize: 'console.x'`).
 * A registry symbol, so it is found without depending on that package.
 */
export const CONSOLE_GATE = Symbol.for('@dudousxd/aviary:console-gate');

/** The shape of the {@link CONSOLE_GATE} provider. */
export interface ConsoleGate {
  allows(name: string, context: ExecutionContext): Promise<ConsoleAuthorizeResult>;
}

/** The one boot warning for a console with no `authorize`. Same wording in every Aviary console. */
export function consoleAuthorizeMissingWarning(packageName: string, registration: string): string {
  return `[${packageName}] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in ${registration}.`;
}

/** {@link consoleAuthorizeMissingWarning} for `TelescopeModule`. */
export const CONSOLE_AUTHORIZE_MISSING_WARNING = consoleAuthorizeMissingWarning(
  '@dudousxd/nestjs-telescope',
  'TelescopeModule.forRoot()',
);

// Every decision is a fresh object: callers may keep or change what they get.
const allow = (): ConsoleDecision => ({ allowed: true });
const forbidden = (): ConsoleDecision => ({ allowed: false, reason: 'forbidden' });
const unauthenticated = (): ConsoleDecision => ({ allowed: false, reason: 'unauthenticated' });

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A class with `authorize()`: on the prototype, or (an instance-property arrow
 * function, `authorize = (ctx) => ...`) only on instances, so any `class`.
 */
function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  if (typeof value !== 'function') return false;
  if (
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  ) {
    return true;
  }
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function isPolicyCheck(value: unknown): value is ConsolePolicyCheck {
  return isRecord(value) && typeof value.policy === 'function' && typeof value.ability === 'string';
}

function isLazyModule(value: unknown): value is { default: ConsoleAuthorizerClass } {
  return isRecord(value) && isAuthorizerClass(value.default);
}

/** Turns any {@link ConsoleAuthorizeResult} into a {@link ConsoleDecision}. */
export function normalizeConsoleResult(result: unknown): ConsoleDecision {
  if (result === true) return allow();
  if (!isRecord(result)) return forbidden();
  if (typeof result.redirectTo === 'string' && result.allowed !== true) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: result.redirectTo };
  }
  if (result.allowed === true) return allow();
  return result.reason === 'unauthenticated' ? unauthenticated() : forbidden();
}

/** `null`, `undefined` and `false` mean "nobody signed in", like `@nestjs/authorization`'s guard. */
function hasUser(user: unknown): boolean {
  return user !== null && user !== undefined && user !== false;
}

function gateDecider(name: string, moduleRef: ModuleRef): ConsoleDecide {
  let gate: ConsoleGate | undefined;
  try {
    gate = moduleRef.get<ConsoleGate>(CONSOLE_GATE, { strict: false });
  } catch {
    gate = undefined;
  }
  if (!gate) {
    throw new Error(
      `\`authorize: '${name}'\` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }.`,
    );
  }
  const resolved = gate;
  return async (context) => normalizeConsoleResult(await resolved.allows(name, context));
}

/** One instance per class and registration: the registered provider when there is one, else a fresh one. */
function classDecider(moduleRef: ModuleRef): (Class: ConsoleAuthorizerClass) => ConsoleDecide {
  const instances = new Map<ConsoleAuthorizerClass, Promise<ConsoleAuthorizer>>();
  const instanceOf = (Class: ConsoleAuthorizerClass): Promise<ConsoleAuthorizer> => {
    const cached = instances.get(Class);
    if (cached) return cached;
    const pending = (async (): Promise<ConsoleAuthorizer> => {
      try {
        const registered = moduleRef.get(Class, { strict: false });
        if (registered) return registered;
      } catch {
        // Not a registered provider: build one with its dependencies injected.
      }
      return moduleRef.create(Class);
    })();
    // A failed construction is retried on the next request rather than cached.
    pending.catch(() => instances.delete(Class));
    instances.set(Class, pending);
    return pending;
  };
  return (Class) => async (context) =>
    normalizeConsoleResult(await (await instanceOf(Class)).authorize(context));
}

interface AuthorizationApi {
  AuthorizationService: Type<{
    can(policy: Type<unknown>, ability: string, user: unknown): Promise<boolean>;
  }>;
  AUTHORIZATION_MODULE_OPTIONS: string | symbol;
  defaultGetUser: (context: ExecutionContext) => unknown;
}

const AUTHORIZATION_PACKAGE = '@nestjs/authorization';

async function policyDecider(
  { policy, ability }: ConsolePolicyCheck,
  moduleRef: ModuleRef,
): Promise<ConsoleDecide> {
  let api: AuthorizationApi;
  try {
    // A variable specifier: an optional peer, never a static import.
    api = (await import(AUTHORIZATION_PACKAGE)) as AuthorizationApi;
  } catch {
    throw new Error(
      `\`authorize: { policy, ability }\` needs ${AUTHORIZATION_PACKAGE} installed (npm i ${AUTHORIZATION_PACKAGE}); or pass a function, a class, or a gate name.`,
    );
  }
  let service: InstanceType<AuthorizationApi['AuthorizationService']> | undefined;
  try {
    service = moduleRef.get(api.AuthorizationService, { strict: false });
  } catch {
    service = undefined;
  }
  if (!service) {
    throw new Error(
      `\`authorize: { policy, ability }\` needs AuthorizationModule.forRoot() from ${AUTHORIZATION_PACKAGE} imported in the app.`,
    );
  }
  // The user the official `AuthorizationGuard` sees: the module's `getUser`, else the default one
  // (`request.user`). `null` and `false` are an answer, a guest, never looked up any further.
  let getUser = api.defaultGetUser;
  try {
    const options = moduleRef.get<{ getUser?: (context: ExecutionContext) => unknown }>(
      api.AUTHORIZATION_MODULE_OPTIONS,
      { strict: false },
    );
    if (typeof options?.getUser === 'function') getUser = options.getUser;
  } catch {
    // No module options: the default `getUser` applies.
  }
  const authorization = service;
  return async (context) => {
    const user = await getUser(context);
    const signedIn = hasUser(user);
    if (await authorization.can(policy, ability, signedIn ? user : null)) return allow();
    return signedIn ? forbidden() : unauthenticated();
  };
}

/** Options of {@link resolveConsoleAuthorize}. */
export interface ResolveConsoleAuthorizeOptions {
  /** Where the "no `authorize`" warning and the "`authorize` threw" warnings go. */
  logger?: Logger;
  /** Log {@link CONSOLE_AUTHORIZE_MISSING_WARNING} when `authorize` is omitted. Default `true`. */
  warnIfMissing?: boolean;
  /** The text of that warning. Default {@link CONSOLE_AUTHORIZE_MISSING_WARNING}. */
  missingWarning?: string;
}

/**
 * Resolves `authorize` into one function the guard calls per request. Configuration mistakes (a
 * gate name without nestjs-authz, a policy without `@nestjs/authorization` or its module) reject
 * here, so call it at boot. The returned function never throws: an error is a `forbidden`, logged
 * at `warn`, never an allow.
 *
 * `authorize` omitted: open outside production, `forbidden` for every request in production, and
 * one warning logged (unless `warnIfMissing: false`).
 */
export async function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize | undefined,
  moduleRef: ModuleRef,
  options: ResolveConsoleAuthorizeOptions = {},
): Promise<ConsoleDecide> {
  const logger = options.logger ?? new Logger('TelescopeModule');
  if (authorize === undefined) {
    if (options.warnIfMissing !== false) {
      logger.warn(options.missingWarning ?? CONSOLE_AUTHORIZE_MISSING_WARNING);
    }
    const production = isProduction();
    return async () => (production ? forbidden() : allow());
  }

  let decide: ConsoleDecide;
  if (typeof authorize === 'string') {
    decide = gateDecider(authorize, moduleRef);
  } else if (isPolicyCheck(authorize)) {
    decide = await policyDecider(authorize, moduleRef);
  } else if (isAuthorizerClass(authorize)) {
    decide = classDecider(moduleRef)(authorize);
  } else if (typeof authorize === 'function') {
    const fromClass = classDecider(moduleRef);
    const fn = authorize as (context: ExecutionContext) => unknown;
    let lazy: ConsoleDecide | undefined;
    decide = async (context) => {
      if (lazy) return lazy(context);
      const result = await fn(context);
      if (!isLazyModule(result)) return normalizeConsoleResult(result);
      // A lazy import: remember the class, so the import runs once per registration.
      lazy = fromClass(result.default);
      return lazy(context);
    };
  } else {
    throw new Error(
      '`authorize` must be a function, a class with authorize(), a lazy import, { policy, ability } or a gate name.',
    );
  }

  return async (context) => {
    try {
      return await decide(context);
    } catch (error) {
      logger.warn(
        `console \`authorize\` threw, denying the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return forbidden();
    }
  };
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Allows a request carrying `Authorization: Bearer <token>` (compared timing-safe); anything else
 * is `unauthenticated`. Header only: no query string, no custom header. Throws when `token` is
 * empty, so a missing env var fails at config time instead of opening the console.
 */
export function authorizeByToken(options: { token: string | undefined }): (
  context: ExecutionContext,
) => ConsoleAuthorizeResult {
  const token = options.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('authorizeByToken: `token` is empty; set it (e.g. from an env var).');
  }
  const expected = sha256(token);
  return (context) => {
    const header = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>()
      ?.headers?.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(sha256(match[1]), expected)) return true;
    return { allowed: false, reason: 'unauthenticated' };
  };
}
