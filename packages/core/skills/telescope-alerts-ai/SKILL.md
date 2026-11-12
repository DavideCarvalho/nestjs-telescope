---
name: telescope-alerts-ai
description: >-
  Alerting and AI exception diagnosis in nestjs-telescope. Configure alerts with
  channel helpers (slackChannel, webhookChannel, customChannel) and rules
  (new-exception, exception-rate, slow-request-rate, dropped-entries,
  metric-threshold); understand the default that 4xx HttpExceptions are NOT
  recorded as exception entries (exceptions.captureHttp4xx restores it); wire AI
  diagnosis with ai.{diagnoser,mode} + createAiSdkDiagnoser({ model }) from
  @dudousxd/nestjs-telescope-ai over any Vercel AI SDK model (Bedrock/OpenAI/
  Anthropic); enable public client-error ingestion. Use for "Slack alert on new
  errors", "AI diagnose exceptions", "why is my 403 not in the exceptions tab".
license: MIT
metadata:
  type: core
  library: "@dudousxd/nestjs-telescope"
  library_version: "1.12.0"
  framework: nestjs
---

# Alerting & AI diagnosis

Telescope can page you when a genuinely new exception family appears (or a rate
threshold trips) and, optionally, attach an AI probable-cause report to the
exception. Both are `forRoot` options.

## Setup

Fan alerts to one or more channels; `rules` selects what fires. A configured
`alerts` with no destination or empty `rules` is a fail-closed boot error.

```ts
import { TelescopeModule, slackChannel } from '@dudousxd/nestjs-telescope';

TelescopeModule.forRoot({
  alerts: {
    channels: [slackChannel(process.env.SLACK_WEBHOOK_URL!)],
    dashboardUrl: 'https://telescope.example.com/telescope/', // enables Slack deep links
    rules: [
      { type: 'new-exception', window: '1h' },
      { type: 'exception-rate', window: '5m', threshold: 10 },
    ],
  },
});
```

Source: `packages/core/src/alerts/alert-rule.ts` (`AlertsOptions`, `AlertRule`),
`packages/core/src/alerts/alert-channel.ts` (`slackChannel` / `webhookChannel` /
`customChannel`).

## Core patterns

### Pattern 1 — the alert rule types

`rules` is a non-empty array of discriminated unions:

```ts
rules: [
  { type: 'new-exception', window: '1h' },                                  // a brand-new family
  { type: 'exception-rate', window: '5m', threshold: 10 },                  // > N exceptions / window
  { type: 'slow-request-rate', window: '5m', thresholdMs: 1000, count: 5 }, // N slow reqs / window
  { type: 'dropped-entries', threshold: 100 },                             // Telescope itself dropped entries
];
```

Source: `packages/core/src/alerts/alert-rule.ts` (`AlertRule`).

### Pattern 2 — AI exception diagnosis

Add the AI package and supply a `diagnoser`. `mode: 'on-demand'` (default) only
runs on the dashboard button; `mode: 'auto'` also diagnoses a NEW family on the
flush path and enriches its `new-exception` alert.

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { createAiSdkDiagnoser } from '@dudousxd/nestjs-telescope-ai';
import { openai } from '@ai-sdk/openai';

TelescopeModule.forRoot({
  ai: {
    diagnoser: createAiSdkDiagnoser({ model: openai('gpt-4o-mini'), maxOutputTokens: 1024 }),
    mode: 'on-demand',
  },
});
```

The diagnoser is provider-agnostic via the Vercel AI SDK (swap `openai(...)` for
`bedrock(...)` / `anthropic(...)`). It runs on already-redacted exception data.
With console tenancy on, diagnoses are cached and built per organization: a
viewer of one organization only gets one made from that organization's
occurrences; a viewer of every organization reads the family's unscoped one.
Source: `packages/ai/src/ai-sdk-diagnoser.ts` (`createAiSdkDiagnoser`),
`packages/core/src/ai/diagnoser.ts` (`TelescopeAiOptions`),
`website/content/docs/recipes/ai-exception-diagnosis.mdx`.

### Pattern 3 — public client-error ingestion

Let browsers POST errors to `<telescope>/api/client-errors`; they become
`client_exception` entries through the same pipeline. Disabled by default.

```ts
TelescopeModule.forRoot({
  clientErrors: {
    enabled: true,
    maxBodyBytes: 32_768,
    rateLimit: { perMinute: 60 },
  },
});
```

The endpoint is public by design: it takes neither the console's `decorators`
nor its `authorize`. To gate it, use `routes: false` and extend
`ClientErrorController` with `UseConsoleAuthorize` or your own decorators.

Source: `packages/core/src/nest/telescope.options.ts` (`ClientErrorsOptions`).

## Common mistakes

### Mistake 1 — expecting every 4xx in the exceptions tab

```ts
// Wrong — assuming a 403/404/validation-400 shows up as an exception entry. By
// default it does NOT (it's control flow), so no family, no alert, no diagnosis.
TelescopeModule.forRoot({ alerts: { channels: [slackChannel(url)], rules: [{ type: 'new-exception', window: '1h' }] } });
```

```ts
// Correct — opt in only if you truly treat 4xx as incidents worth grouping/paging.
TelescopeModule.forRoot({
  exceptions: { captureHttp4xx: true },
  alerts: { channels: [slackChannel(url)], rules: [{ type: 'new-exception', window: '1h' }] },
});
```

Mechanism: a 4xx `HttpException` is expected control flow; recording it would open
a new family and page Slack for every permission denial. The 4xx is still on the
`request` entry's `statusCode`. Source:
`packages/core/src/nest/telescope.options.ts` (`ExceptionsOptions`).

### Mistake 2 — `alerts` with rules but no channel

```ts
// Wrong — no channels is a fail-closed BOOT error.
TelescopeModule.forRoot({ alerts: { rules: [{ type: 'new-exception', window: '1h' }] } });
```

```ts
// Correct — supply at least one destination.
TelescopeModule.forRoot({
  alerts: { channels: [slackChannel(url)], rules: [{ type: 'new-exception', window: '1h' }] },
});
```

Mechanism: a configured `alerts` with no `channels` or empty `rules` throws at boot rather than silently never
alerting. Source: `packages/core/src/alerts/alert-rule.ts` (`AlertsOptions`).

### Mistake 3 — hand-rolling a Slack POST instead of the channel helper

```ts
// Wrong — a custom function that posts plain text loses the Block Kit formatting,
// route/user context, and the "Open in Telescope" deep link.
alerts: { channels: [customChannel(async (a) => fetch(url, { method: 'POST', body: a.title }))], rules };
```

```ts
// Correct — use slackChannel; pass dashboardUrl for deep links.
alerts: {
  channels: [slackChannel(process.env.SLACK_WEBHOOK_URL!)],
  dashboardUrl: 'https://telescope.example.com/telescope/',
  rules,
};
```

Mechanism: `slackChannel` renders Block Kit with route/user and builds an
`${dashboardUrl}#/entries/exception/${id}` deep link when `dashboardUrl` is set;
`customChannel` is the escape hatch for non-Slack sinks. Source:
`packages/core/src/alerts/alert-channel.ts`, `packages/core/src/alerts/alert-rule.ts`.
