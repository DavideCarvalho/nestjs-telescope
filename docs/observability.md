# Observability: get any library into Telescope (and Grafana) with one line

Telescope sees third-party libraries through dedicated watchers. For libraries
**you** own, you don't need a watcher — emit a diagnostics event and Telescope's
generic watcher records it, and the OTel exporter forwards it to Grafana as
`telescope_diagnostic_total{lib,event}`.

```ts
import { emit, getChannel } from '@dudousxd/nestjs-diagnostics';

const channel = getChannel('mylib', 'thing-happened');
export function doThing() {
  if (channel.hasSubscribers) {
    emit('mylib', 'thing-happened', { detail: 'value' });
  }
}
```

That's it — no watcher, no Telescope-specific code. When the OTel exporter is
installed, every `emit` shows up as a metric and (via the recorded entry) a span.
