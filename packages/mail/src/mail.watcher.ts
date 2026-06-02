// packages/mail/src/mail.watcher.ts
import {
  EntryType,
  type RecordInput,
  type Watcher,
  type WatcherContext,
} from '@dudousxd/nestjs-telescope';

/** The subset of nodemailer's `SendMailOptions` we read. Structural, so the
 *  watcher never hard-depends on nodemailer's types. */
export interface MailOptions {
  from?: string;
  to?: string | string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Optional per-message mailer override; falls back to the watcher default. */
  mailer?: string;
}

/** The structural transporter surface we wrap — any nodemailer transport (or a
 *  test double) that exposes `sendMail` satisfies it. */
export interface MailTransport {
  sendMail(options: MailOptions): Promise<unknown>;
}

export interface MailWatcherOptions {
  /** Mailer name recorded when an option doesn't override it. Default 'nodemailer'. */
  mailer?: string;
}

/** Marks a transporter whose `sendMail` we've already wrapped, so re-registering
 *  the same instance (or two watchers sharing it) never double-wraps. */
const PATCHED = Symbol.for('@dudousxd/nestjs-telescope:mailPatched');

const PREVIEW_LIMIT = 280;

/** Normalize `to` (string | string[] | undefined) to a flat string[]. */
function normalizeTo(to: MailOptions['to']): string[] {
  if (Array.isArray(to)) return to.filter((value) => typeof value === 'string');
  return typeof to === 'string' ? [to] : [];
}

/** A short, plain preview from the body — text preferred, else html stripped. */
function buildPreview(options: MailOptions): string | null {
  const source = options.text ?? options.html;
  if (typeof source !== 'string' || source.length === 0) return null;
  const collapsed = source.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > PREVIEW_LIMIT ? collapsed.slice(0, PREVIEW_LIMIT) : collapsed;
}

/**
 * Captures every email sent through a nodemailer transporter.
 *
 * ## How it works
 * The host hands the watcher its transporter; `register()` patches that
 * instance's `sendMail` with a wrapper. The wrapper runs in the caller's async
 * context (the active request/job ALS scope), so each captured mail entry is
 * correlated to the batch that triggered it — no batch is opened here.
 *
 * On a resolved send it records a `'sent'` entry and returns the transport's
 * result unchanged; on a rejected send it records `'failed'` and re-throws so
 * the host's error handling is untouched.
 *
 * @remarks
 * Patching is per-instance and idempotent (guarded by a `Symbol.for` marker).
 * Wrapping the instance — not the prototype — keeps other transporters of the
 * same class un-instrumented, matching the explicit "host hands us this one
 * transporter" contract.
 */
export class MailWatcher implements Watcher {
  readonly type = EntryType.Mail;
  private readonly transport: MailTransport;
  private readonly mailer: string;

  constructor(transport: MailTransport, options: MailWatcherOptions = {}) {
    this.transport = transport;
    this.mailer = options.mailer ?? 'nodemailer';
  }

  register(ctx: WatcherContext): void {
    const transport = this.transport as MailTransport & { [PATCHED]?: boolean };
    if (transport[PATCHED]) return;
    transport[PATCHED] = true;

    const original = transport.sendMail.bind(transport);
    const watcher = this;

    transport.sendMail = async function patchedSendMail(options: MailOptions): Promise<unknown> {
      try {
        const result = await original(options);
        watcher.safeRecord(ctx, options, 'sent');
        return result;
      } catch (error) {
        watcher.safeRecord(ctx, options, 'failed');
        throw error; // never swallow the host's error
      }
    };
  }

  /** Build + record a mail entry, swallowing any record failure so a telescope
   *  error can never turn a successful send into a failed one. */
  private safeRecord(ctx: WatcherContext, options: MailOptions, status: 'sent' | 'failed'): void {
    try {
      const mailer = options.mailer ?? this.mailer;
      const input: RecordInput = {
        type: EntryType.Mail,
        familyHash: mailer,
        content: {
          mailer,
          from: options.from ?? null,
          to: normalizeTo(options.to),
          subject: options.subject ?? null,
          preview: buildPreview(options),
          status,
        },
      };
      if (status === 'failed') input.tags = ['failed'];
      ctx.record(input);
    } catch (recordError) {
      const message = recordError instanceof Error ? recordError.message : String(recordError);
      console.error(`MailWatcher: failed to record mail entry: ${message}`);
    }
  }
}
