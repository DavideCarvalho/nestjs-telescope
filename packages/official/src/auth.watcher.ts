// packages/official/src/auth.watcher.ts
import { createHash } from 'node:crypto';
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { ChannelWatcher, eventOf } from './channel-watcher.js';
import { OFFICIAL_CHANNEL_NAMES, OfficialEntryType } from './channels.js';
import { asRecord, bool, id, num, pick, readError, str } from './read.js';

/** Events that are a refusal or a security signal. Tagged `failed`. */
const FAILURES = new Set([
  'mfa-failed',
  'refresh-token-reused',
  'magic-link-refused',
  'session-touch-failed',
  'denied',
]);

/**
 * A short, one-way reference to a secret identifier (a session id, a refresh-token family): the
 * first 12 hex digits of its SHA-256. Lets an operator tell that a sign-in and a sign-out were the
 * same session without the entry holding anything that authenticates.
 */
export function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** `jane.doe@example.com` → `j***@example.com`. Not an address → `***`. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

/** The id of the user an authorization policy saw, read structurally; never the user object. */
function userIdOf(user: unknown): string | undefined {
  const u = asRecord(user);
  if (u === null) return undefined;
  for (const key of ['id', 'sub', 'userId']) {
    const value = id(u[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Map a `nestjs:authentication:<type>` event (`@nestjs/authentication`) to an `auth` entry.
 *
 * Only known, non-secret fields are copied (an unknown field a later version adds is NOT recorded
 * until it is reviewed here). Redaction:
 * - `sessionId` / `tokenFamilyId` → `sessionRef` / `tokenFamilyRef`, a SHA-256 {@link fingerprint};
 * - `email` → masked (`j***@example.com`);
 * - `metadata` (what the app stores beside the session) → its key names only;
 * - `error` → name, message and code; no stack.
 * `userId` is kept (a numeric id as its string form, as for authorization denials): it is what makes the audit trail useful, and Telescope already tags entries
 * with the current user.
 */
export function authenticationEntry(channel: string, message: unknown): RecordInput | null {
  const p = asRecord(message);
  if (p === null) return null;
  const event = str(p.type) ?? eventOf(channel);
  const content: Record<string, unknown> = {
    source: 'authentication',
    event,
    ...pick(p, ['userId'], id),
    ...pick(p, ['method', 'mfa', 'reason'], str),
    ...pick(p, ['failures', 'count'], num),
    ...pick(p, ['locked', 'replaced', 'everywhere'], bool),
  };
  const sessionId = str(p.sessionId);
  if (sessionId !== undefined) content.sessionRef = fingerprint(sessionId);
  const tokenFamilyId = str(p.tokenFamilyId);
  if (tokenFamilyId !== undefined) content.tokenFamilyRef = fingerprint(tokenFamilyId);
  const email = str(p.email);
  if (email !== undefined) content.email = maskEmail(email);
  const metadata = asRecord(p.metadata);
  if (metadata !== null) content.metadataKeys = Object.keys(metadata);
  const error = readError(p.error);
  if (error !== null) content.error = error;
  return finish(event, content);
}

/**
 * Map `nestjs:authorization:denied` (`@nestjs/authorization`) to an `auth` entry: which policy and
 * ability refused whom, why (`unauthenticated` / `forbidden`) and on which handler. The event hands
 * over the whole user and the policy's arguments (records); only the user's id (`id`, `sub` or
 * `userId`) and the number of arguments are kept, as the package's own docs advise.
 */
export function authorizationEntry(channel: string, message: unknown): RecordInput | null {
  const p = asRecord(message);
  if (p === null) return null;
  const event = str(p.type) ?? eventOf(channel);
  const content: Record<string, unknown> = {
    source: 'authorization',
    event,
    policy: str(p.policy) ?? null,
    ability: str(p.ability) ?? null,
    ...pick(p, ['reason', 'handler'], str),
  };
  const userId = userIdOf(p.user);
  if (userId !== undefined) content.userId = userId;
  if (Array.isArray(p.args)) content.argCount = p.args.length;
  const input = finish(event, content);
  input.familyHash = `denied:${str(p.policy) ?? 'none'}.${str(p.ability) ?? 'none'}`;
  return input;
}

function finish(event: string, content: Record<string, unknown>): RecordInput {
  const tags = [`auth:${event}`];
  if (FAILURES.has(event)) tags.push('failed');
  return { type: OfficialEntryType.Auth, familyHash: event, content, tags };
}

function authEntry(channel: string, message: unknown): RecordInput | null {
  return channel.startsWith('nestjs:authorization:')
    ? authorizationEntry(channel, message)
    : authenticationEntry(channel, message);
}

export interface NestAuthWatcherOptions {
  /** Record `@nestjs/authentication`'s events. Default `true`. */
  authentication?: boolean;
  /** Record `@nestjs/authorization`'s denials. Default `true`. */
  authorization?: boolean;
}

/**
 * Records the authentication audit trail (sign-ins, sign-outs, second factor, password resets,
 * refused magic links, refresh-token reuse) and authorization denials as `auth` entries, redacted.
 */
export class NestAuthWatcher extends ChannelWatcher {
  constructor(options: NestAuthWatcherOptions = {}) {
    super(
      OfficialEntryType.Auth,
      [
        ...(options.authentication === false ? [] : OFFICIAL_CHANNEL_NAMES.authentication),
        ...(options.authorization === false ? [] : OFFICIAL_CHANNEL_NAMES.authorization),
      ],
      authEntry,
    );
  }
}
