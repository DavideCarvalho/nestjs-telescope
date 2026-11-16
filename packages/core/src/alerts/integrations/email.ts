// packages/core/src/alerts/integrations/email.ts
import type { AlertChannel } from '../alert-channel.js';
import type { AlertPayload } from '../alert-rule.js';
import { plainText } from './chat.js';
import { escapeHtml } from './html.js';
import {
  type ChannelRouting,
  clip,
  integrationChannel,
  linkOf,
  requireFields,
  titleOf,
} from './incident.js';

/** The message the email channel hands to the host's mailer. */
export interface AlertEmailMessage {
  to: string[];
  from?: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Anything with a nodemailer-style `sendMail(message)`: a nodemailer
 * `Transporter`, `@nestjs-modules/mailer`'s `MailerService`, or your own
 * wrapper. Structural, so Telescope ships no mail dependency.
 */
export interface MailTransportLike {
  sendMail(message: AlertEmailMessage): Promise<unknown>;
}

/** A function that sends one alert email. */
export type AlertEmailSender = (message: AlertEmailMessage) => Promise<unknown>;

export interface EmailOptions extends ChannelRouting {
  /** Recipients. */
  to: string | string[];
  /** Sender address. Default: whatever the transport is configured with. */
  from?: string;
  /** Subject prefix. Default `'[Telescope]'`. */
  subjectPrefix?: string;
  /**
   * How to send: a nodemailer-style transport (`{ sendMail }`), or a function
   * that sends the message. A function is called on each send, so it can reach
   * a mailer built later in boot (`(message) => this.mailer.sendMail(message)`).
   */
  transport: MailTransportLike | AlertEmailSender;
}

/** The subject, text and HTML bodies for an alert email. */
export function emailContent(
  alert: AlertPayload,
  subjectPrefix = '[Telescope]',
): { subject: string; text: string; html: string } {
  const text = plainText(alert);
  const link = linkOf(alert);
  const html = [
    `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    ...(link !== null ? [`<p><a href="${escapeHtml(link)}">Open in Telescope</a></p>`] : []),
  ].join('\n');
  return { subject: clip(`${subjectPrefix} ${titleOf(alert)}`, 200), text, html };
}

function isTransport(value: unknown): value is MailTransportLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sendMail' in value &&
    typeof value.sendMail === 'function'
  );
}

/**
 * Email through a mailer the host already has: a nodemailer transporter,
 * `MailerService`, or a send function. The alert email goes out from the
 * alerter's timers, never the request path, and a failure is isolated like any
 * other channel's.
 */
export function emailChannel(options: EmailOptions): AlertChannel {
  requireFields('email', options, ['to', 'transport']);
  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  const transport = options.transport;
  const sender: AlertEmailSender = isTransport(transport)
    ? (message) => transport.sendMail(message)
    : transport;
  return integrationChannel('email', options, async (alert) => {
    const content = emailContent(alert, options.subjectPrefix);
    await sender({
      to: recipients,
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...content,
    });
  });
}
