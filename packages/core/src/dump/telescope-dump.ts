// packages/core/src/dump/telescope-dump.ts

/**
 * A free-function debug dump — the dev-tool counterpart to `console.log`, but
 * routed into Telescope's "Dumps" tab and correlated to the active request
 * batch. It needs NO dependency injection at the call site: `telescopeDump`
 * forwards to a module-level sink that the Telescope module wires on init (and
 * clears on shutdown). Until wired — or after shutdown — the call is a no-op,
 * so importing it in shared code never crashes outside a Telescope-enabled app.
 */

type DumpSink = (value: unknown, label?: string) => void;

let sink: DumpSink | null = null;

/**
 * Install (or clear, with `null`) the dump sink. Called by the Telescope module
 * lifecycle — hosts and devs should not call this directly.
 * @internal
 */
export function setTelescopeDump(fn: DumpSink | null): void {
  sink = fn;
}

/**
 * Record a value (with an optional label) into Telescope's Dumps tab. Safe to
 * call anywhere: a no-op until the Telescope module has wired the sink.
 */
export function telescopeDump(value: unknown, label?: string): void {
  sink?.(value, label);
}
