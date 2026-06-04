# @dudousxd/nestjs-telescope-logs

Log watcher for [`@dudousxd/nestjs-telescope`](../../README.md). Captures Nest
`Logger` output and records each line as a `log` entry, correlated to the request
or job that produced it.

## How it works

Two pieces:

- **`TelescopeConsoleLogger`** — a drop-in `ConsoleLogger` you install as the app
  logger. It logs to the console as usual and, in addition, forwards every line
  to Telescope's log sink.
- **`LogsWatcher`** — wires that sink to the Recorder at registration. Until the
  watcher wires the sink, the logger just logs (no recording), so using it
  outside a Telescope-enabled app never crashes.

Because the logger emits in the caller's async context, each captured line lands
in the active request/job batch automatically. No batch is opened here.

## Install

```sh
pnpm add @dudousxd/nestjs-telescope-logs
```

`@nestjs/common` is already a peer of your Nest app — no extra runtime deps.

## Usage

Install the logger as the app logger and add the watcher to Telescope:

```ts
import { NestFactory } from '@nestjs/core';
import { TelescopeModule } from '@dudousxd/nestjs-telescope';
import { LogsWatcher, TelescopeConsoleLogger } from '@dudousxd/nestjs-telescope-logs';

const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(new TelescopeConsoleLogger());
```

```ts
TelescopeModule.forRoot({
  watchers: [new LogsWatcher()],
});
```

Each captured entry has type `log` and `LogContent`:

```ts
{
  level: string;          // log | error | warn | debug | verbose
  message: string;        // stringified message
  context: string | null; // logger context, or null when none
}
```

## Internal-context skip list

Telescope's own log output is skipped so the watcher never records its own lines
or feeds a feedback loop. Any logger context starting with one of these prefixes
is dropped before it reaches the sink:

- `Telescope`
- `Recorder`
- `LogsWatcher`
- `EventsWatcher`

The list is intentionally small. If you have an application context that starts
with one of these prefixes, rename it (or those lines won't be recorded).

`ctx.record` failures are swallowed so a telescope error can never break your
app's logging.

## License

MIT © Davi Carvalho
