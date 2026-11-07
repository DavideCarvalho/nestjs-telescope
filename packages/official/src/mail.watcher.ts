// packages/official/src/mail.watcher.ts
import type { RecordInput } from '@dudousxd/nestjs-telescope';
import { ChannelWatcher, eventOf } from './channel-watcher.js';
import { OFFICIAL_CHANNEL_NAMES, OfficialEntryType } from './channels.js';
import { asRecord, bool, num, pick, readError, str, strArray } from './read.js';

/** The `mailer` the entries carry, so they group apart from `@dudousxd/nestjs-telescope-mail`'s. */
export const NEST_MAIL_MAILER = '@nestjs/mail';

/**
 * Map `nestjs:mail:sent` / `nestjs:mail:failed` (`@nestjs/mail`) to Telescope's built-in `mail`
 * entry, so the existing Mail tab shows them. The event carries no sender or body, so `from` and
 * `preview` are `null`; the envelope recipients are `to` (as the nodemailer watcher records them).
 * Grouped by mail class, else by mailer.
 */
export function mailEntry(channel: string, message: unknown): RecordInput | null {
  const p = asRecord(message);
  if (p === null) return null;
  const status = str(p.type) ?? eventOf(channel);
  const mail = str(p.mail);
  const content: Record<string, unknown> = {
    mailer: NEST_MAIL_MAILER,
    from: null,
    to: strArray(p.recipients),
    subject: str(p.subject) ?? null,
    preview: null,
    status,
    ...pick(p, ['mail', 'transport', 'messageId', 'providerMessageId'], str),
    ...pick(p, ['attempts'], num),
    ...pick(p, ['permanent'], bool),
  };
  const error = readError(p.error);
  if (error !== null) content.error = error;
  const input: RecordInput = {
    type: OfficialEntryType.Mail,
    familyHash: mail ?? NEST_MAIL_MAILER,
    content,
  };
  if (status === 'failed') input.tags = ['failed'];
  const durationMs = num(p.durationMs);
  if (durationMs !== undefined) input.durationMs = durationMs;
  return input;
}

/** Records what `@nestjs/mail` sent and what failed after its retries, as `mail` entries. */
export class NestMailWatcher extends ChannelWatcher {
  constructor() {
    super(OfficialEntryType.Mail, OFFICIAL_CHANNEL_NAMES.mail, mailEntry);
  }
}
