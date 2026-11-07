// packages/official/src/official-watchers.ts
import type { Watcher } from '@dudousxd/nestjs-telescope';
import { NestAuthWatcher, type NestAuthWatcherOptions } from './auth.watcher.js';
import { NestMailWatcher } from './mail.watcher.js';
import { NestResilienceWatcher } from './resilience.watcher.js';
import { NestWorkflowsWatcher } from './workflows.watcher.js';

export interface OfficialWatchersOptions {
  /** `@nestjs/resilience` events. Default `true`. */
  resilience?: boolean;
  /** `@nestjs/workflows` events. Default `true`. */
  workflows?: boolean;
  /** `@nestjs/authentication` / `@nestjs/authorization` events, or `false` for neither. */
  auth?: boolean | NestAuthWatcherOptions;
  /**
   * `@nestjs/mail` events. Default `true`. Turn it off if the same mailer is also wrapped by
   * `@dudousxd/nestjs-telescope-mail`'s `MailWatcher`, or each send is recorded twice.
   */
  mail?: boolean;
}

/**
 * Every official-channel watcher, for `TelescopeModule.forRoot({ watchers: [...officialWatchers()] })`.
 * A package that is not installed publishes nothing, so its watcher records nothing and costs nothing.
 */
export function officialWatchers(options: OfficialWatchersOptions = {}): Watcher[] {
  const watchers: Watcher[] = [];
  if (options.resilience !== false) watchers.push(new NestResilienceWatcher());
  if (options.workflows !== false) watchers.push(new NestWorkflowsWatcher());
  if (options.auth !== false) {
    watchers.push(new NestAuthWatcher(typeof options.auth === 'object' ? options.auth : {}));
  }
  if (options.mail !== false) watchers.push(new NestMailWatcher());
  return watchers;
}
