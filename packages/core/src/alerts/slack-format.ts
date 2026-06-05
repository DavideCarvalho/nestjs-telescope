// packages/core/src/alerts/slack-format.ts
import type { AlertPayload } from './alert-rule.js';

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
  if (rule.type === 'new-exception' || rule.type === 'exception-rate') return ':rotating_light:';
  if (rule.type === 'dropped-entries') return ':warning:';
  return ':snail:';
}

/** Short, human rule label for the header (the `type` is machine-y on its own). */
function ruleLabel(rule: AlertPayload['rule']): string {
  switch (rule.type) {
    case 'new-exception':
      return 'New exception family';
    case 'exception-rate':
      return 'Exception rate';
    case 'slow-request-rate':
      return 'Slow request rate';
    case 'dropped-entries':
      return 'Dropped entries';
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

/**
 * Build the deep link to the offending exception entry in the host's external
 * dashboard. Returns `null` when no `dashboardUrl` is configured or there is no
 * entry id to link to (rate rules carry no single id). The hash route mirrors the
 * SPA's `#/entries/exception/:id`.
 */
function dashboardLink(payload: AlertPayload): string | null {
  const { dashboardUrl, exception } = payload;
  if (dashboardUrl === undefined || exception === undefined) return null;
  const base = dashboardUrl.replace(/\/+$/, '');
  return `${base}#/entries/exception/${exception.entryId}`;
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
  const headerText = `${emoji} ${label}`;

  const contextFields: SlackTextObject[] = [
    field('Instance', payload.instanceId),
    field('Observed', `${payload.value} (threshold ${payload.threshold})`),
  ];

  const exception = payload.exception;
  if (exception !== undefined) {
    contextFields.push(field('Error', `${exception.class}: ${exception.message}`));
    if (exception.route !== null) {
      const method = exception.method ?? '';
      const status = exception.statusCode === null ? '' : ` → ${exception.statusCode}`;
      contextFields.push(field('Route', `${method} ${exception.route}${status}`.trim()));
    }
    if (exception.durationMs !== null) {
      contextFields.push(field('Duration', `${exception.durationMs} ms`));
    }
    if (exception.user !== null) {
      contextFields.push(field('User', exception.user));
    }
    contextFields.push(field('Occurrences', `${exception.occurrences} in window`));
  } else {
    // Rate rules carry the matched rule's window; surface it for context.
    const window = 'window' in payload.rule ? payload.rule.window : null;
    if (window !== null) contextFields.push(field('Window', window));
  }

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
    { type: 'section', fields: contextFields },
  ];

  const stack = exception ? clipStack(exception.stack) : null;
  if (stack !== null) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${stack}\`\`\`` } });
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
