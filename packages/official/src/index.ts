// packages/official/src/index.ts
export * from './channels.js';
export { ChannelWatcher, type ChannelMapper } from './channel-watcher.js';
export { NestResilienceWatcher, resilienceEntry } from './resilience.watcher.js';
export { NestWorkflowsWatcher, workflowEntry } from './workflows.watcher.js';
export {
  NestAuthWatcher,
  type NestAuthWatcherOptions,
  authenticationEntry,
  authorizationEntry,
  fingerprint,
  maskEmail,
} from './auth.watcher.js';
export { NEST_MAIL_MAILER, NestMailWatcher, mailEntry } from './mail.watcher.js';
export { officialWatchers, type OfficialWatchersOptions } from './official-watchers.js';
export {
  type NestAiUsageEvent,
  type TelescopeAiUsageListener,
  type TelescopeAiUsageOptions,
  telescopeAiUsage,
  usagePayload,
} from './ai-usage.js';
export {
  ObserveTraceContextProvider,
  type ObserveTracer,
  syntheticSpanId,
  toW3cTraceId,
} from './observe-trace-context.provider.js';
export {
  resilienceTelescopeExtension,
  type ResilienceCircuitRow,
  type ResilienceTelescopeOptions,
} from './resilience-telescope.js';
