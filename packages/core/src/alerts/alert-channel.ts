// packages/core/src/alerts/alert-channel.ts
import type { AlertPayload } from './alert-rule.js';
import { type SlackChannelOptions, formatSlackMessage } from './slack-format.js';

/**
 * A delivery destination for a fired alert. Channels are the v2 generalization of
 * the v1 single `webhookUrl`: an alert fans out to EVERY configured channel
 * concurrently, and a single channel failing NEVER blocks the others (the alerter
 * isolates and warn-logs failures per channel). Implementations MUST NOT throw
 * into the host on their own — but even if one does, the alerter catches it; the
 * contract is simply "deliver this payload, or reject, and we'll log it".
 *
 * `name` is a stable, human-readable identifier used only for rate-limited
 * failure logging (e.g. `"slack"`, `"webhook"`, or a custom channel's name) so an
 * operator can tell WHICH destination is failing without leaking its URL.
 */
export interface AlertChannel {
  /** Stable identifier for failure logging (never the raw URL/secret). */
  name: string;
  /** Deliver the payload. Rejecting is fine — the alerter isolates + logs it. */
  send(alert: AlertPayload): Promise<void>;
}

/**
 * POST timeout for the built-in HTTP channels. A hung endpoint must never stall
 * the alerter's fan-out, so every request is raced against an abort timer.
 */
const HTTP_CHANNEL_TIMEOUT_MS = 5_000;

/**
 * Injectable `fetch` seam so tests can drive the HTTP channels deterministically
 * without a real network. Mirrors the subset of `fetch` the channels use.
 */
export type ChannelFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<unknown>;

/**
 * POST a JSON body to `url` with a hard abort timeout. Shared by the webhook and
 * Slack channels — the ONLY difference between them is the body shape, so the
 * transport lives here once. Rejects on network error / non-2xx-driven throw /
 * timeout; the alerter turns that rejection into a rate-limited warn.
 */
async function postJson(fetchImpl: ChannelFetch, url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_CHANNEL_TIMEOUT_MS);
  timeout.unref?.();
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Raw-JSON webhook channel — today's v1 behavior, preserved verbatim: it POSTs
 * the {@link AlertPayload} as-is so existing relays that parse the raw body keep
 * working. The legacy top-level `webhookUrl` option is internally rewritten into
 * one of these, which is why the payload shape stayed additive/backward-compatible.
 *
 * @param url Destination that receives `POST <AlertPayload as JSON>`.
 * @param fetchImpl Test seam; defaults to global `fetch`.
 */
export function webhookChannel(url: string, fetchImpl?: ChannelFetch): AlertChannel {
  const send: ChannelFetch = fetchImpl ?? ((u, init) => fetch(u, init));
  return {
    name: 'webhook',
    send(alert: AlertPayload): Promise<void> {
      return postJson(send, url, alert);
    },
  };
}

/**
 * Slack-formatted channel — POSTs Block Kit JSON to a Slack incoming webhook so
 * the message renders as a rich, human-readable card (severity header, fielded
 * context, a truncated stack snippet, and a deep link to the dashboard entry when
 * `dashboardUrl` is configured) instead of a raw JSON blob. See
 * {@link formatSlackMessage} for the exact block structure and Slack's limits.
 *
 * @param url Slack incoming webhook URL.
 * @param options Formatting knobs (currently `username`/`iconEmoji` overrides).
 * @param fetchImpl Test seam; defaults to global `fetch`.
 */
export function slackChannel(
  url: string,
  options?: SlackChannelOptions,
  fetchImpl?: ChannelFetch,
): AlertChannel {
  const send: ChannelFetch = fetchImpl ?? ((u, init) => fetch(u, init));
  return {
    name: 'slack',
    send(alert: AlertPayload): Promise<void> {
      return postJson(send, url, formatSlackMessage(alert, options));
    },
  };
}

/**
 * Custom channel — the escape hatch. The host supplies an arbitrary async sink
 * (send an email, publish to SNS, page someone, write a row, …) and Telescope
 * calls it with the rich {@link AlertPayload}. As with every channel, a rejection
 * is isolated and logged by the alerter, so the host's `fn` may freely throw.
 *
 * @param fn Async sink invoked with the fired alert payload.
 * @param name Identifier for failure logging. Defaults to `"custom"`.
 */
export function customChannel(
  fn: (alert: AlertPayload) => Promise<void>,
  name = 'custom',
): AlertChannel {
  return { name, send: fn };
}
