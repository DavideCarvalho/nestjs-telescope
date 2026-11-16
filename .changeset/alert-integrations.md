---
'@dudousxd/nestjs-telescope': minor
---

Alert integrations: on-call (`pagerDutyChannel`, `opsgenieChannel`, `betterStackIncidentChannel`, `incidentIoChannel`, `grafanaOnCallChannel`), chat (`discordChannel`, `teamsChannel`, `telegramChannel`, `googleChatChannel`) and `emailChannel` (bring your own nodemailer-style transport). Rules take `severity` and `channels`, channels take `minSeverity`, and an interval rule that stops firing sends one `resolved` notification to the channels that accept it, sharing an incident key with the trigger (`alerts.app` names the service). New `alerts.heartbeats` (healthchecks.io, Better Stack, Cronitor, Uptime Kuma, UptimeRobot, any URL), `alerts.statusPages` (Atlassian Statuspage, Instatus, Better Stack) and `uptimeHandler()` read check states from `alerts.checkStates` or `publishCheckStates()`. Slack, webhook and custom channels behave as before.
