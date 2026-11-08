// packages/official/src/channels.ts

/**
 * The `node:diagnostics_channel` channels NestJS's first-party packages publish, verified against
 * the published tarballs:
 *
 * | package                    | version | channels                                   |
 * | -------------------------- | ------- | ------------------------------------------ |
 * | `@nestjs/resilience`       | 0.0.3   | `nestjs:resilience:<type>`, 9 fixed types  |
 * | `@nestjs/workflows`        | 0.0.5   | `nestjs:workflows:<type>`, 19 event types  |
 * | `@nestjs/authentication`   | 0.1.5   | `nestjs:authentication:<type>`, 13 types   |
 * | `@nestjs/authorization`    | 0.1.3   | `nestjs:authorization:denied`              |
 * | `@nestjs/mail`             | 0.0.2   | `nestjs:mail:sent`, `nestjs:mail:failed`   |
 *
 * Kept local on purpose: `@dudousxd/nestjs-diagnostics` is growing the same constants
 * (`OFFICIAL_CHANNELS`), and these lists can come from there once it is published. Each package
 * creates its channel lazily on first publish, so subscribing by name to one that is not installed
 * costs nothing and never throws.
 */

export const RESILIENCE_EVENT_TYPES = [
  'retry',
  'timeout',
  'circuit-open',
  'circuit-half-open',
  'circuit-closed',
  'circuit-rejected',
  'bulkhead-rejected',
  'rate-limited',
  'fallback',
] as const;
export type ResilienceEventType = (typeof RESILIENCE_EVENT_TYPES)[number];

export const WORKFLOW_EVENT_TYPES = [
  'workflow-started',
  'workflow-resumed',
  'workflow-suspended',
  'workflow-compensating',
  'workflow-completed',
  'workflow-failed',
  'workflow-cancelled',
  'workflow-compensation-failed',
  'step-completed',
  'step-failed',
  'step-compensated',
  'child-started',
  'signal-received',
  'signal-timed-out',
  'journal-large',
  'custom-status',
  'workflow-retried',
  'workflow-deleted',
  'schedule-skipped',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

export const AUTHENTICATION_EVENT_TYPES = [
  'sign-in',
  'sign-out',
  'mfa-verified',
  'mfa-failed',
  'mfa-enabled',
  'mfa-disabled',
  'recovery-codes-generated',
  'refresh-token-reused',
  'password-reset-requested',
  'password-reset',
  'email-verified',
  'magic-link-refused',
  'session-touch-failed',
] as const;
export type AuthenticationEventType = (typeof AUTHENTICATION_EVENT_TYPES)[number];

export const AUTHORIZATION_EVENT_TYPES = ['denied'] as const;
export const MAIL_EVENT_TYPES = ['sent', 'failed'] as const;

/** `nestjs:<lib>:<type>` for every type of a list. */
function names<T extends string>(lib: string, types: readonly T[]): string[] {
  return types.map((type) => `nestjs:${lib}:${type}`);
}

/** Every channel name, by package. */
export const OFFICIAL_CHANNEL_NAMES = {
  resilience: names('resilience', RESILIENCE_EVENT_TYPES),
  workflows: names('workflows', WORKFLOW_EVENT_TYPES),
  authentication: names('authentication', AUTHENTICATION_EVENT_TYPES),
  authorization: names('authorization', AUTHORIZATION_EVENT_TYPES),
  mail: names('mail', MAIL_EVENT_TYPES),
} as const;

/** The entry types the official watchers record. Mail reuses Telescope's built-in `mail`. */
export const OfficialEntryType = {
  Resilience: 'resilience',
  Workflow: 'workflow',
  Auth: 'auth',
  Mail: 'mail',
} as const;
