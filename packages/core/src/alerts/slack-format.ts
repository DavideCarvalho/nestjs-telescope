// packages/core/src/alerts/slack-format.ts
import type { AlertGeoLocation, AlertPayload } from './alert-rule.js';

/**
 * Optional Slack presentation overrides. Most hosts set none of these — the
 * incoming webhook's own default name/icon is used. Provided for hosts that route
 * several Telescope instances into one channel and want them visually distinct.
 */
export interface SlackChannelOptions {
  /** Override the bot username shown on the message. */
  username?: string;
  /** Override the message icon (a Slack emoji shortcode, e.g. `:rotating_light:`). */
  iconEmoji?: string;
}

/**
 * Slack hard limits we format within. A `text` field in a section is capped at
 * 3000 chars; we keep the stack snippet WELL under that (the code fence + other
 * fields share the block) and additionally cap by frame count so the message
 * stays scannable rather than a wall of frames.
 */
const STACK_CHAR_LIMIT = 2_800;
const STACK_FRAME_LIMIT = 10;

/**
 * Slack caps a `section` block's `fields` array at 10 items — an 11th makes Slack
 * reject the WHOLE message with `400 invalid_blocks`. A fully-enriched exception
 * (instance + observed + error + route + UA + referer + duration + user + client
 * IP + location + occurrences) exceeds that, so we spread the fields across as
 * many section blocks as needed rather than overflowing one.
 */
const MAX_SECTION_FIELDS = 10;

/**
 * Char budget for the AI diagnosis section. The diagnoser is already bounded by
 * `maxOutputTokens`, but a long report still has to share Slack's per-section
 * 3000-char cap with its `*Probable cause (AI):*` label, so we hard-clip here.
 */
const DIAGNOSIS_CHAR_LIMIT = 2_800;

/**
 * Minimal structural typings for the Block Kit subset we emit. We deliberately do
 * NOT pull in Slack's full SDK types — alerting must stay dependency-light, and
 * the shape we produce is small and stable. These exist so the formatter is fully
 * typed (no `any`) and tests can assert structure.
 */
interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}
interface SlackHeaderBlock {
  type: 'header';
  text: SlackTextObject;
}
interface SlackSectionBlock {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
}
interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url: string;
}
interface SlackActionsBlock {
  type: 'actions';
  elements: SlackButtonElement[];
}
type SlackBlock = SlackHeaderBlock | SlackSectionBlock | SlackActionsBlock;

/** The full webhook body Slack expects: a fallback `text` plus the rich `blocks`. */
export interface SlackMessage {
  /** Fallback/notification text shown where blocks can't render. */
  text: string;
  blocks: SlackBlock[];
  username?: string;
  icon_emoji?: string;
}

/**
 * Severity → leading emoji. Telescope has no severity model yet, so we derive a
 * coarse one from the rule kind: a brand-new error family or an exception spike is
 * the loudest signal an operator can get, dropped entries means we're losing data
 * (serious but not user-facing), and a slow-request spike is a warning.
 */
function severityEmoji(rule: AlertPayload['rule']): string {
  if (
    rule.type === 'new-exception' ||
    rule.type === 'every-exception' ||
    rule.type === 'exception-rate'
  ) {
    return ':rotating_light:';
  }
  if (rule.type === 'dropped-entries') return ':warning:';
  return ':snail:';
}

/** Short, human rule label for the header (the `type` is machine-y on its own). */
function ruleLabel(rule: AlertPayload['rule']): string {
  switch (rule.type) {
    case 'new-exception':
      return 'New exception family';
    case 'every-exception':
      return 'Exception';
    case 'exception-rate':
      return 'Exception rate';
    case 'slow-request-rate':
      return 'Slow request rate';
    case 'dropped-entries':
      return 'Dropped entries';
    case 'metric-threshold':
      return `Metric threshold (${rule.metric})`;
  }
}

/** A Slack `mrkdwn` field pairing a bold label with a value. */
function field(label: string, value: string): SlackTextObject {
  return { type: 'mrkdwn', text: `*${label}:*\n${value}` };
}

/**
 * Clip a raw stack to Slack's budget: keep at most {@link STACK_FRAME_LIMIT}
 * lines, then hard-cap the joined string at {@link STACK_CHAR_LIMIT} chars (a
 * single huge frame can still blow the budget). Returns `null` for an absent
 * stack so the caller can omit the block entirely rather than render an empty
 * code fence.
 */
function clipStack(stack: string | null): string | null {
  if (stack === null || stack.trim() === '') return null;
  const frames = stack.split('\n').slice(0, STACK_FRAME_LIMIT).join('\n');
  if (frames.length <= STACK_CHAR_LIMIT) return frames;
  return `${frames.slice(0, STACK_CHAR_LIMIT)}…`;
}

/** Regional-indicator flag emoji for an ISO 3166-1 alpha-2 code, or `''`. */
function flagEmoji(countryCode: string | undefined): string {
  if (countryCode === undefined || !/^[A-Za-z]{2}$/.test(countryCode)) return '';
  const cc = countryCode.toUpperCase();
  const base = 0x1f1e6 - 65; // 'A' → 🇦
  return String.fromCodePoint(base + cc.charCodeAt(0), base + cc.charCodeAt(1));
}

/**
 * Render a coarse geo location as `🇺🇸 City, Region, Country`, skipping absent or
 * duplicate parts (a city equal to its region isn't repeated). Returns `null` when
 * there's nothing to show, so the caller omits the field entirely.
 */
function formatGeo(geo: AlertGeoLocation | null | undefined): string | null {
  if (!geo) return null;
  const parts: string[] = [];
  if (geo.city) parts.push(geo.city);
  if (geo.region && geo.region !== geo.city) parts.push(geo.region);
  if (geo.country && geo.country !== geo.region) parts.push(geo.country);
  if (parts.length === 0) return null;
  const flag = flagEmoji(geo.countryCode);
  return flag ? `${flag} ${parts.join(', ')}` : parts.join(', ');
}

/**
 * Clip an auxiliary code block (React component stack / serialized `extra`) to
 * Slack's per-section budget. Returns `null` for absent/empty input so the caller
 * omits the block rather than rendering an empty fence.
 */
function clipBlock(text: string | null): string | null {
  if (text === null || text.trim() === '') return null;
  if (text.length <= STACK_CHAR_LIMIT) return text;
  return `${text.slice(0, STACK_CHAR_LIMIT)}…`;
}

/**
 * Best-effort pretty JSON for the `extra` bag. The Recorder already redacted +
 * depth-bounded it, but a circular ref could still slip through a host-built
 * object, so we fall back to a placeholder rather than throwing into formatting.
 */
function safeJson(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

/** Trim + length-cap the AI diagnosis; `null`/empty passes through as `null`. */
function clipDiagnosis(diagnosis: string | undefined): string | null {
  if (diagnosis === undefined || diagnosis.trim() === '') return null;
  const trimmed = diagnosis.trim();
  if (trimmed.length <= DIAGNOSIS_CHAR_LIMIT) return trimmed;
  return `${trimmed.slice(0, DIAGNOSIS_CHAR_LIMIT)}…`;
}

/**
 * Build the deep link to the offending exception entry in the host's external
 * dashboard. Returns `null` when no `dashboardUrl` is configured or there is no
 * entry id to link to (rate rules carry no single id).
 *
 * The hash route mirrors the SPA's entry-DETAIL route `#/entries/view/:id`
 * (see `packages/ui/src/app/App.tsx`). It deliberately does NOT use the older
 * `#/entries/:type/:id` shape: `#/entries/<type>` matches the type-scoped LIST
 * route `#/entries/:type`, so a recipient clicking the button landed on an empty
 * filtered list rather than the entry detail. The detail view is type-agnostic
 * (the same `EntryPage` renders both `exception` and `client_exception` by id),
 * so a single `view/:id` link works for both.
 */
function dashboardLink(payload: AlertPayload): string | null {
  const { dashboardUrl, exception } = payload;
  if (dashboardUrl === undefined || exception === undefined) return null;
  const base = dashboardUrl.replace(/\/+$/, '');
  return `${base}#/entries/view/${exception.entryId}`;
}

/**
 * Render an {@link AlertPayload} into a Slack Block Kit message. Structure:
 *  - a `header` with the severity emoji + rule label;
 *  - a `section` whose fields carry the app/rule context (instance, value vs
 *    threshold, window, and — for `new-exception` — route/method/status/user and
 *    the occurrence count);
 *  - a `section` with a fenced code block of the truncated stack (only when an
 *    exception stack is present);
 *  - an `actions` block with a single "Open in Telescope" button (only when a
 *    `dashboardUrl` + entry id are available to build the deep link).
 *
 * Everything degrades gracefully: a rate rule (no `exception` context) simply
 * renders the header + context fields and skips the stack/button.
 */
export function formatSlackMessage(
  payload: AlertPayload,
  options?: SlackChannelOptions,
): SlackMessage {
  const emoji = severityEmoji(payload.rule);
  const label = ruleLabel(payload.rule);
  // Badge a brand-new error family distinctly from a recurrence so on-call can
  // triage urgency at a glance. Only exceptions carry this; rate rules don't.
  const badge =
    payload.exception === undefined
      ? ''
      : payload.exception.isNew
        ? ' · 🆕 New'
        : ' · 🔁 Recurring';
  const headerText = `${emoji} ${label}${badge}`;

  const contextFields: SlackTextObject[] = [
    field('Instance', payload.instanceId),
    field('Observed', `${payload.value} (threshold ${payload.threshold})`),
  ];

  const exception = payload.exception;
  if (exception !== undefined) {
    contextFields.push(field('Error', `${exception.class}: ${exception.message}`));
    if (exception.route !== null) {
      // For a client_exception, `route` is the page URL (no method/status).
      const label = exception.client ? 'URL' : 'Route';
      const method = exception.method ?? '';
      const status = exception.statusCode === null ? '' : ` → ${exception.statusCode}`;
      contextFields.push(field(label, `${method} ${exception.route}${status}`.trim()));
    }
    if (exception.userAgent !== null) {
      contextFields.push(field('User agent', exception.userAgent));
    }
    if (exception.referer !== null) {
      contextFields.push(field('Referer', exception.referer));
    }
    if (exception.durationMs !== null) {
      contextFields.push(field('Duration', `${exception.durationMs} ms`));
    }
    if (exception.user !== null) {
      contextFields.push(field('User', exception.user));
    }
    if (exception.clientIp !== null) {
      contextFields.push(field('Client IP', exception.clientIp));
    }
    const geoText = formatGeo(exception.geo);
    if (geoText !== null) {
      contextFields.push(field('Location', geoText));
    }
    contextFields.push(field('Occurrences', `${exception.occurrences} in window`));
  } else {
    // Rate rules carry the matched rule's window; surface it for context.
    const window = 'window' in payload.rule ? payload.rule.window : null;
    if (window !== null) contextFields.push(field('Window', window));
  }

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
  ];
  // Spread the context fields across section blocks of at most MAX_SECTION_FIELDS —
  // one overflowing section makes Slack reject the entire message.
  for (let i = 0; i < contextFields.length; i += MAX_SECTION_FIELDS) {
    blocks.push({ type: 'section', fields: contextFields.slice(i, i + MAX_SECTION_FIELDS) });
  }

  const stack = exception ? clipStack(exception.stack) : null;
  if (stack !== null) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${stack}\`\`\`` } });
  }

  // React component stack (client_exception from an error boundary), when present.
  const componentStack = exception ? clipBlock(exception.componentStack) : null;
  if (componentStack !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Component stack:*\n\`\`\`${componentStack}\`\`\`` },
    });
  }

  // Host-defined free-form `extra` bag (client_exception), serialized as JSON.
  const extra =
    exception && exception.extra !== null && Object.keys(exception.extra).length > 0
      ? clipBlock(safeJson(exception.extra))
      : null;
  if (extra !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Extra:*\n\`\`\`${extra}\`\`\`` },
    });
  }

  // AI probable-cause note (auto-mode), when one finished within the alert grace.
  // Slack's mrkdwn isn't full markdown, but headings/bullets degrade readably; we
  // just length-cap so the diagnosis can't blow Slack's 3000-char section budget.
  const diagnosis = clipDiagnosis(payload.diagnosis);
  if (diagnosis !== null) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Probable cause (AI):*\n${diagnosis}` },
    });
  }

  const link = dashboardLink(payload);
  if (link !== null) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Telescope', emoji: true },
          url: link,
        },
      ],
    });
  }

  return {
    // Fallback text mirrors the header so notifications/badges are meaningful.
    text: headerText,
    blocks,
    ...(options?.username !== undefined ? { username: options.username } : {}),
    ...(options?.iconEmoji !== undefined ? { icon_emoji: options.iconEmoji } : {}),
  };
}
