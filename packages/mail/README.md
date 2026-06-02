# @dudousxd/nestjs-telescope-mail

Mail watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Wraps a
[nodemailer](https://nodemailer.com) transporter's `sendMail` to capture every
email your app sends — sender, recipients, subject, a short body preview, and
whether it was sent or failed — correlated to the request or job that sent it.

`sendMail` runs in the caller's async context, so each captured mail entry lands
in the active request/job batch automatically. No batch is opened by this
watcher.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-mail
```

`nodemailer` is an optional peer (the transporter type is structural, so any
object exposing `sendMail(options): Promise<unknown>` works).

## Usage

Hand the watcher your transporter and register it on the module:

```ts
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { MailWatcher } from '@dudousxd/nestjs-telescope-mail';
import { createTransport } from 'nodemailer';

const transporter = createTransport({ host: 'smtp.example.com', port: 587 });

@Module({
  imports: [
    TelescopeModule.forRoot({
      watchers: [new MailWatcher(transporter, { mailer: 'ses' })],
    }),
  ],
})
export class AppModule {}
```

Each captured entry has type `mail` and `MailContent`:

```ts
{
  mailer: string;          // option override, else the `mailer` default ('nodemailer')
  from: string | null;
  to: string[];            // normalized from string | string[]
  subject: string | null;
  preview: string | null;  // short slice of text (or html), whitespace-collapsed
  status: 'sent' | 'failed';
}
```

On a rejected send the watcher records `status: 'failed'` (tagged `failed`) and
re-throws, so your error handling is untouched. Recording failures are swallowed
— a telescope error can never turn a successful send into a failed one.

The patch is per-transporter and idempotent (a `Symbol.for` marker), so
re-registering the same transporter wraps `sendMail` only once.

## License

MIT © Davi Carvalho
