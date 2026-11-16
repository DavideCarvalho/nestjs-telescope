// packages/core/src/alerts/integrations/chat.ts
import type { AlertChannel } from '../alert-channel.js';
import type { AlertPayload, AlertSeverity } from '../alert-rule.js';
import { escapeHtml } from './html.js';
import { deliver } from './http.js';
import {
  appOf,
  clip,
  integrationChannel,
  linkOf,
  requireFields,
  severityOf,
  statusOf,
  summaryLines,
  titleOf,
} from './incident.js';
import type { OnCallOptions } from './on-call.js';

/**
 * Chat channels: one message per notification (firing, and resolved when an
 * interval rule resolves). Repeats are already limited by the alerter's cooldown.
 */

/** Options shared by every chat channel: routing plus retry/timeout knobs. */
export type ChatOptions = OnCallOptions;

const SEVERITY_COLOR: Record<AlertSeverity, number> = {
  critical: 0xd92d20,
  error: 0xf04438,
  warning: 0xf79009,
  info: 0x2e90fa,
};
const RESOLVED_COLOR = 0x12b76a;

function colorOf(alert: AlertPayload): number {
  return statusOf(alert) === 'resolved' ? RESOLVED_COLOR : SEVERITY_COLOR[severityOf(alert)];
}

/** `[label, value]` facts shown as fields by the rich formats. */
function factsOf(alert: AlertPayload): Array<[string, string]> {
  const facts: Array<[string, string]> = [
    ['App', appOf(alert)],
    ['Rule', alert.rule.type],
    ['Severity', severityOf(alert)],
    ['Status', statusOf(alert)],
  ];
  const ex = alert.exception;
  if (ex !== undefined) {
    if (ex.route !== null) facts.push(['Route', `${ex.method ?? ''} ${ex.route}`.trim()]);
    if (ex.statusCode !== null) facts.push(['Status code', String(ex.statusCode)]);
    facts.push(['Occurrences', String(ex.occurrences)]);
    if (ex.user !== null) facts.push(['User', ex.user]);
  } else {
    facts.push(['Value', String(alert.value)], ['Threshold', String(alert.threshold)]);
  }
  return facts;
}

function bodyText(alert: AlertPayload): string | null {
  const parts: string[] = [];
  const stack = alert.exception?.stack;
  if (stack !== null && stack !== undefined) parts.push(clip(stack, 1000));
  if (alert.diagnosis !== undefined) {
    parts.push(`Probable cause (AI):\n${clip(alert.diagnosis, 1500)}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Discord — webhook with embeds
// ---------------------------------------------------------------------------

export interface DiscordOptions extends ChatOptions {
  /** Discord webhook URL. */
  url: string;
  /** Overrides the webhook's username. */
  username?: string;
  /** Overrides the webhook's avatar. */
  avatarUrl?: string;
}

/** Discord rejects an embed whose title, description, fields and footer exceed 6000 characters. */
const DISCORD_EMBED_TOTAL = 6000;

/** The combined length Discord counts toward {@link DISCORD_EMBED_TOTAL}. */
function discordEmbedLength(embed: {
  title: string;
  description?: string | undefined;
  fields: Array<{ name: string; value: string }>;
  footer: { text: string };
}): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) +
    embed.footer.text.length
  );
}

/** The Discord execute-webhook body (one embed, mentions disabled). */
export function discordMessage(
  alert: AlertPayload,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl'> = {},
): Record<string, unknown> {
  const link = linkOf(alert);
  const body = bodyText(alert);
  const embed: {
    title: string;
    url?: string;
    color: number;
    description?: string | undefined;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    timestamp: string;
    footer: { text: string };
  } = {
    title: clip(titleOf(alert), 256),
    ...(link !== null ? { url: link } : {}),
    color: colorOf(alert),
    ...(body !== null ? { description: clip(`\`\`\`\n${body}\n\`\`\``, 4000) } : {}),
    fields: factsOf(alert).map(([name, value]) => ({
      name,
      value: clip(value, 1024),
      inline: true,
    })),
    timestamp: alert.firedAt,
    footer: { text: 'Telescope' },
  };
  // Per-field clips can still add up past Discord's combined limit: shorten
  // the description (the stack / diagnosis) first, then the field values.
  let over = discordEmbedLength(embed) - DISCORD_EMBED_TOTAL;
  if (over > 0 && embed.description !== undefined) {
    const keep = embed.description.length - over;
    // `undefined` drops the key when the body is serialized.
    embed.description = keep > 10 ? clip(embed.description, keep) : undefined;
    over = discordEmbedLength(embed) - DISCORD_EMBED_TOTAL;
  }
  for (const field of embed.fields) {
    if (over <= 0) break;
    const keep = Math.max(1, field.value.length - over);
    const before = field.value.length;
    field.value = clip(field.value, keep);
    over -= before - field.value.length;
  }
  return {
    ...(options.username !== undefined ? { username: options.username } : {}),
    ...(options.avatarUrl !== undefined ? { avatar_url: options.avatarUrl } : {}),
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

/** Native Discord channel (embeds), instead of pointing `slackChannel` at the `/slack` shim. */
export function discordChannel(options: DiscordOptions): AlertChannel {
  requireFields('discord', options, ['url']);
  return integrationChannel('discord', options, async (alert) => {
    await deliver({ url: options.url, body: discordMessage(alert, options) }, options);
  });
}

// ---------------------------------------------------------------------------
// Microsoft Teams — Workflows webhook with an Adaptive Card
// ---------------------------------------------------------------------------

export interface TeamsOptions extends ChatOptions {
  /** The Teams Workflows ("Post to a channel when a webhook request is received") URL. */
  url: string;
}

/** The Teams Workflows body: one Adaptive Card attachment. */
export function teamsMessage(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  const body = bodyText(alert);
  const resolved = statusOf(alert) === 'resolved';
  const severity = severityOf(alert);
  const color = resolved
    ? 'Good'
    : severity === 'warning' || severity === 'info'
      ? 'Warning'
      : 'Attention';
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: clip(titleOf(alert), 300),
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              color,
            },
            {
              type: 'FactSet',
              facts: factsOf(alert).map(([title, value]) => ({ title, value })),
            },
            ...(body !== null
              ? [{ type: 'TextBlock', text: clip(body, 2000), wrap: true, fontType: 'Monospace' }]
              : []),
          ],
          ...(link !== null
            ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Telescope', url: link }] }
            : {}),
        },
      },
    ],
  };
}

/** Microsoft Teams via a Workflows webhook (Adaptive Card). */
export function teamsChannel(options: TeamsOptions): AlertChannel {
  requireFields('teams', options, ['url']);
  return integrationChannel('teams', options, async (alert) => {
    await deliver({ url: options.url, body: teamsMessage(alert) }, options);
  });
}

// ---------------------------------------------------------------------------
// Telegram — Bot API sendMessage
// ---------------------------------------------------------------------------

export interface TelegramOptions extends ChatOptions {
  /** Bot token from @BotFather. It goes in the URL path and is never logged. */
  botToken: string;
  /** Target chat id (user, group or `@channel`). */
  chatId: string | number;
  /** Forum topic id, for groups with topics. */
  messageThreadId?: number;
  /** Bot API base. Default `https://api.telegram.org`. */
  baseUrl?: string;
}

/** The `sendMessage` body (HTML parse mode, link previews off). */
export function telegramMessage(
  alert: AlertPayload,
  options: Pick<TelegramOptions, 'chatId' | 'messageThreadId'>,
): Record<string, unknown> {
  const lines = [`<b>${escapeHtml(titleOf(alert))}</b>`];
  for (const [label, value] of factsOf(alert)) {
    lines.push(`${escapeHtml(label)}: ${escapeHtml(value)}`);
  }
  const body = bodyText(alert);
  if (body !== null) lines.push(`<pre>${escapeHtml(clip(body, 1500))}</pre>`);
  const link = linkOf(alert);
  if (link !== null) lines.push(`<a href="${escapeHtml(link)}">Open in Telescope</a>`);
  return {
    chat_id: options.chatId,
    text: clip(lines.join('\n'), 4096),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(options.messageThreadId !== undefined
      ? { message_thread_id: options.messageThreadId }
      : {}),
  };
}

/** Telegram via the Bot API. */
export function telegramChannel(options: TelegramOptions): AlertChannel {
  requireFields('telegram', options, ['botToken', 'chatId']);
  const base = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  const url = `${base}/bot${options.botToken}/sendMessage`;
  return integrationChannel('telegram', options, async (alert) => {
    await deliver({ url, body: telegramMessage(alert, options) }, options);
  });
}

// ---------------------------------------------------------------------------
// Google Chat — incoming webhook
// ---------------------------------------------------------------------------

export interface GoogleChatOptions extends ChatOptions {
  /** Space webhook URL (it carries the key and token). */
  url: string;
  /**
   * Thread every notification of the same incident together (by app + rule).
   * Default `true`.
   */
  threaded?: boolean;
}

/**
 * The Google Chat webhook body: `text` (always set, so the title still posts
 * when a space ignores cards) plus a `cardsV2` card.
 */
export function googleChatMessage(alert: AlertPayload): Record<string, unknown> {
  const link = linkOf(alert);
  const body = bodyText(alert);
  return {
    text: clip(titleOf(alert), 4000),
    cardsV2: [
      {
        cardId: 'telescope-alert',
        card: {
          header: { title: clip(titleOf(alert), 200), subtitle: 'Telescope' },
          sections: [
            {
              widgets: [
                ...factsOf(alert).map(([topLabel, text]) => ({
                  decoratedText: { topLabel, text: clip(text, 500) },
                })),
                ...(body !== null ? [{ textParagraph: { text: clip(body, 2000) } }] : []),
                ...(link !== null
                  ? [
                      {
                        buttonList: {
                          buttons: [
                            { text: 'Open in Telescope', onClick: { openLink: { url: link } } },
                          ],
                        },
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Google Chat via a space webhook, threaded per app + rule by default. */
export function googleChatChannel(options: GoogleChatOptions): AlertChannel {
  requireFields('google-chat', options, ['url']);
  return integrationChannel('google-chat', options, async (alert) => {
    const threaded = options.threaded ?? true;
    const body = googleChatMessage(alert);
    let url = options.url;
    if (threaded) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
      body.thread = { threadKey: `telescope-${appOf(alert)}-${alert.rule.type}` };
    }
    await deliver({ url, body }, options);
  });
}

/** Plain-text rendering of an alert, used by the email channel. */
export function plainText(alert: AlertPayload): string {
  const body = bodyText(alert);
  return [titleOf(alert), '', ...summaryLines(alert), ...(body !== null ? ['', body] : [])].join(
    '\n',
  );
}
