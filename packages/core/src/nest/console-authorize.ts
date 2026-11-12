// packages/core/src/nest/console-authorize.ts
//
// The console access contract shared (structurally, by copy) by every Aviary
// console: the `authorize` option, its resolver and `authorizeByToken`.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExecutionContext, Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** Class form: an @Injectable() provider (constructor injection works). */
export interface ConsoleAuthorizer {
  authorize(context: ExecutionContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}
export type ConsoleAuthorizerClass = Type<ConsoleAuthorizer>;

/** @nestjs/authorization policy check: policy[ability](user). */
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

/** The provider `@dudousxd/nestjs-authz` registers to resolve `authorize: '<name>'`. */
export const CONSOLE_GATE = Symbol.for('@dudousxd/aviary:console-gate');

/** The shape of the {@link CONSOLE_GATE} provider. */
export interface ConsoleGate {
  allows(name: string, context: ExecutionContext): Promise<ConsoleAuthorizeResult>;
}

/**
 * The resolved check: never throws, answers a {@link ConsoleDecision}. `ready`
 * settles once whatever the form needs at boot (the `@nestjs/authorization`
 * service for the policy form) is in place, and rejects with a clear message
 * when it is missing.
 */
export type ResolvedConsoleAuthorize = ((context: ExecutionContext) => Promise<ConsoleDecision>) & {
  ready: Promise<void>;
};

const ALLOW: ConsoleDecision = { allowed: true };
const FORBIDDEN: ConsoleDecision = { allowed: false, reason: 'forbidden' };
const UNAUTHENTICATED: ConsoleDecision = { allowed: false, reason: 'unauthenticated' };

const logger = new Logger('ConsoleAuthorize');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function isPolicyCheck(value: unknown): value is ConsolePolicyCheck {
  return isRecord(value) && typeof value.policy === 'function' && typeof value.ability === 'string';
}

/** Turns any {@link ConsoleAuthorizeResult} into a {@link ConsoleDecision}. */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleDecision {
  if (result === true) return ALLOW;
  if (!isRecord(result)) return FORBIDDEN;
  if (typeof result.redirectTo === 'string') {
    return { allowed: false, reason: 'unauthenticated', redirectTo: result.redirectTo };
  }
  if (result.allowed === true) return ALLOW;
  return result.reason === 'unauthenticated' ? UNAUTHENTICATED : FORBIDDEN;
}

/** No user, as `@nestjs/authorization` sees it: `null`, `undefined` or `false`. */
function isGuest(user: unknown): boolean {
  return user === null || user === undefined || user === false;
}

function gateMissing(name: string): Error {
  return new Error(
    `\`authorize: '${name}'\` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }.`,
  );
}

/**
 * Resolves an `authorize` option into one check that answers a
 * {@link ConsoleDecision} and never throws: a throw from the app's code is a
 * `forbidden` denial (logged at `warn`), never an allow.
 *
 * A gate name with no `@dudousxd/nestjs-authz` installed throws here. The
 * policy form's boot checks (`@nestjs/authorization` installed, its module
 * imported) surface through `ready`.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
  moduleRef: ModuleRef,
): ResolvedConsoleAuthorize {
  let check: (context: ExecutionContext) => Promise<unknown>;
  let ready: Promise<void> = Promise.resolve();

  if (typeof authorize === 'string') {
    let gate: ConsoleGate;
    try {
      gate = moduleRef.get<ConsoleGate>(CONSOLE_GATE, { strict: false });
    } catch {
      throw gateMissing(authorize);
    }
    if (!gate) throw gateMissing(authorize);
    check = (context) => gate.allows(authorize, context);
  } else if (isPolicyCheck(authorize)) {
    const policy = resolvePolicyCheck(authorize, moduleRef);
    ready = policy.then(() => undefined);
    check = async (context) => (await policy)(context);
  } else if (isAuthorizerClass(authorize)) {
    const instance = authorizerInstance(authorize, moduleRef);
    check = async (context) => (await instance()).authorize(context);
  } else {
    const fn = authorize as (context: ExecutionContext) => unknown;
    // A lazy import resolves to a module whose `default` is the class: memoized
    // per registration, so the import runs once.
    let lazy: (() => Promise<ConsoleAuthorizer>) | undefined;
    check = async (context) => {
      if (lazy) return (await lazy()).authorize(context);
      const result = await fn(context);
      if (isRecord(result) && isAuthorizerClass(result.default)) {
        lazy ??= authorizerInstance(result.default, moduleRef);
        return (await lazy()).authorize(context);
      }
      return result;
    };
  }

  // Mark it handled here; whoever awaits `ready` still sees the rejection.
  ready.catch(() => undefined);

  const resolved = async (context: ExecutionContext): Promise<ConsoleDecision> => {
    try {
      return normalizeConsoleAuthorizeResult(await check(context));
    } catch (error) {
      logger.warn(
        `console \`authorize\` threw, so the request is denied: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return FORBIDDEN;
    }
  };
  return Object.assign(resolved, { ready });
}

/** One instance per registration: the registered provider when there is one, else a fresh one. */
function authorizerInstance(
  Class: ConsoleAuthorizerClass,
  moduleRef: ModuleRef,
): () => Promise<ConsoleAuthorizer> {
  let instance: Promise<ConsoleAuthorizer> | undefined;
  return () => {
    instance ??= (async () => {
      try {
        const registered = moduleRef.get(Class, { strict: false });
        if (registered) return registered;
      } catch {
        // Not a registered provider: build one with its dependencies injected.
      }
      return moduleRef.create(Class);
    })();
    // A failed construction is retried on the next request rather than cached.
    instance.catch(() => {
      instance = undefined;
    });
    return instance;
  };
}

interface AuthorizationApi {
  AuthorizationService: Type<{
    can(policy: Type<unknown>, ability: string, user: unknown): Promise<boolean>;
  }>;
  AUTHORIZATION_MODULE_OPTIONS: string | symbol;
  defaultGetUser: (context: ExecutionContext) => unknown;
}

const AUTHORIZATION_PACKAGE = '@nestjs/authorization';

async function resolvePolicyCheck(
  { policy, ability }: ConsolePolicyCheck,
  moduleRef: ModuleRef,
): Promise<(context: ExecutionContext) => Promise<ConsoleDecision>> {
  let api: AuthorizationApi;
  try {
    api = (await import(AUTHORIZATION_PACKAGE)) as AuthorizationApi;
  } catch {
    throw new Error(
      `\`authorize: { policy: ${policy.name}, ability: '${ability}' }\` needs ${AUTHORIZATION_PACKAGE} installed (npm i ${AUTHORIZATION_PACKAGE}); or pass a function, a class, or a gate name.`,
    );
  }
  let service: InstanceType<AuthorizationApi['AuthorizationService']>;
  try {
    service = moduleRef.get(api.AuthorizationService, { strict: false });
  } catch {
    throw new Error(
      `\`authorize: { policy: ${policy.name}, ability: '${ability}' }\` needs AuthorizationModule.forRoot() from ${AUTHORIZATION_PACKAGE} imported in the app.`,
    );
  }
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
  return async (context) => {
    const user = await getUser(context);
    if (await service.can(policy, ability, user)) return ALLOW;
    return isGuest(user) ? UNAUTHENTICATED : FORBIDDEN;
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * A `ConsoleAuthorize` that allows a request carrying
 * `Authorization: Bearer <token>` (compared in constant time) and answers
 * `unauthenticated` otherwise. Only the header counts: no query string, no
 * custom header. Throws when `token` is empty, so a missing env var fails at
 * config time instead of opening the console.
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
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const header = request?.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(value.trim());
      if (match?.[1] && timingSafeEqual(sha256(match[1]), expected)) return { allowed: true };
    }
    return { allowed: false, reason: 'unauthenticated' };
  };
}
