// packages/core/src/nest/extension-audit.ts
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ExtensionActionCaller } from '../extension/types.js';

const auditLogger = new Logger('TelescopeAudit');

interface ConsoleSeen {
  /** The user `authorize`'s check saw (the `{ policy, ability }` form's `getUser`), when it had an id. */
  user?: string;
}

const seen = new WeakMap<object, ConsoleSeen>();

/** The id of a user value: itself when a string or number, else its `id` or `sub`. */
function userIdOf(user: unknown): string | undefined {
  if (typeof user === 'string' && user !== '') return user;
  if (typeof user === 'number') return String(user);
  if (typeof user !== 'object' || user === null) return undefined;
  const id = (user as { id?: unknown }).id ?? (user as { sub?: unknown }).sub;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined;
}

/** The signed-in user of a session (express-session, cookie-session, passport), when it has an id. */
function sessionUserIdOf(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const s = session as { user?: unknown; userId?: unknown; passport?: { user?: unknown } };
  return userIdOf(s.user) ?? userIdOf(s.userId) ?? userIdOf(s.passport?.user);
}

/**
 * @internal Notes that the console's `authorize` allowed this request, and the user its check
 * saw, for the audit line written later in the request.
 */
export function rememberConsoleCaller(request: unknown, user?: unknown): void {
  if (typeof request !== 'object' || request === null) return;
  const entry = seen.get(request) ?? {};
  const id = userIdOf(user);
  if (id !== undefined) entry.user = id;
  seen.set(request, entry);
}

/**
 * Who is calling, for the audit line: the signed-in user's id (`request.user`, the user the
 * `{ policy, ability }` check saw, or the session's user), else a short hash of the bearer token
 * (never the token), else `console-session` when the console's `authorize` allowed the request,
 * else `anonymous`.
 */
export function consoleCallerOf(request: unknown): string {
  if (typeof request !== 'object' || request === null) return 'anonymous';
  const memo = seen.get(request);
  const req = request as { user?: unknown; session?: unknown; headers?: Record<string, unknown> };
  const user = userIdOf(typeof req.user === 'object' ? req.user : undefined) ?? memo?.user;
  if (user !== undefined) return `user:${user}`;
  const sessionUser = sessionUserIdOf(req.session);
  if (sessionUser !== undefined) return `user:${sessionUser}`;
  const authorization = req.headers?.authorization;
  if (typeof authorization === 'string') {
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (token !== '') {
      return `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
    }
  }
  return memo !== undefined ? 'console-session' : 'anonymous';
}

/** The audit line written for every extension action, from the console or the dev tools. */
export function auditExtensionAction(
  ext: string,
  action: string,
  caller: ExtensionActionCaller,
  input: Record<string, unknown>,
  outcome: 'ok' | 'failed',
): void {
  auditLogger.log(
    `extension action ${ext}.${action} ${outcome} by ${caller.id} via ${caller.via} input=${JSON.stringify(input)}`,
  );
}
