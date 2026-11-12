// packages/core/src/nest/extension-audit.ts
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ExtensionActionCaller } from '../extension/types.js';

const auditLogger = new Logger('TelescopeAudit');

/**
 * Who is calling, for the audit line: the signed-in user's id, else a short hash of the bearer
 * token (never the token), else `anonymous`.
 */
export function consoleCallerOf(request: unknown): string {
  if (typeof request !== 'object' || request === null) return 'anonymous';
  const user = (request as { user?: unknown }).user;
  if (typeof user === 'object' && user !== null) {
    const id = (user as { id?: unknown; sub?: unknown }).id ?? (user as { sub?: unknown }).sub;
    if (typeof id === 'string' || typeof id === 'number') return `user:${id}`;
  }
  const headers = (request as { headers?: Record<string, unknown> }).headers;
  const authorization = headers?.authorization;
  if (typeof authorization === 'string') {
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (token !== '') {
      return `token:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
    }
  }
  return 'anonymous';
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
