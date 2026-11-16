// packages/core/src/alerts/integrations/index.ts
// Alert integrations: on-call, chat, email, heartbeats, status pages, uptime endpoint.
export type {
  ChatOptions,
  DiscordOptions,
  GoogleChatOptions,
  TeamsOptions,
  TelegramOptions,
} from './chat.js';
export {
  discordChannel,
  discordMessage,
  googleChatChannel,
  googleChatMessage,
  teamsChannel,
  teamsMessage,
  telegramChannel,
  telegramMessage,
} from './chat.js';
export type {
  CheckStateSource,
  HealthStatus,
  UptimeBody,
  UptimeCheckState,
  UptimeCheckStatus,
  UptimeEndpointOptions,
  UptimeRequestLike,
} from './check-states.js';
export {
  publishCheckStates,
  publishedCheckStates,
  uptimeHandler,
  uptimeResponse,
} from './check-states.js';
export type {
  AlertEmailMessage,
  AlertEmailSender,
  EmailOptions,
  MailTransportLike,
} from './email.js';
export { emailChannel, emailContent } from './email.js';
export type {
  HeartbeatConfig,
  HeartbeatMonitorDeps,
  HeartbeatOutcome,
  HeartbeatProvider,
} from './heartbeats.js';
export { HeartbeatMonitor, heartbeatRequests } from './heartbeats.js';
export type { HttpDeps, HttpFetch, HttpRequest, HttpResult, RetryOptions } from './http.js';
export { DeliveryError } from './http.js';
export type { ChannelRouting } from './incident.js';
export { incidentKey, routesTo, severityOf } from './incident.js';
export type {
  BetterStackIncidentOptions,
  BetterStackNotify,
  GrafanaOnCallOptions,
  IncidentIoOptions,
  OnCallOptions,
  OpsgenieOptions,
  PagerDutyOptions,
} from './on-call.js';
export {
  betterStackIncident,
  betterStackIncidentChannel,
  grafanaOnCallChannel,
  grafanaOnCallEvent,
  incidentIoChannel,
  incidentIoEvent,
  opsgenieAlert,
  opsgenieChannel,
  pagerDutyChannel,
  pagerDutyEvent,
} from './on-call.js';
export type {
  AtlassianStatuspageConfig,
  BetterStackStatusPageConfig,
  InstatusConfig,
  StatusPageConfig,
  StatusPageSyncDeps,
} from './status-pages.js';
export {
  StatusPageSync,
  componentStatuses,
  statusForKey,
  statusPageRequests,
} from './status-pages.js';
