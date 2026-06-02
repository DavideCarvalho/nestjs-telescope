# Product

## Register

product

## Users

Backend developers building NestJS (TypeScript) applications who need to *see what
their app is actually doing* — every request, query, queued job, sent email, and
thrown exception — correlated and browsable, without standing up a full
observability stack. They reach for this in two moments: locally, debugging "why
did this request do 47 queries?", and in production, where an admin needs to
inspect a failing flow without SSHing into a pod to grep logs. They know Laravel
Telescope (or wish they had it) and expect that experience to exist for NestJS.

## Product Purpose

`@dudousxd/nestjs-telescope` is an application observability console for NestJS: a
set of watchers that capture in-request activity, correlate it under one batch via
AsyncLocalStorage, store it through a pluggable provider, and expose it through a
headless API plus an optional dashboard. It is the missing "Telescope" for NestJS,
designed framework-idiomatically rather than ported. Success: a developer installs
core + one adapter, adds one module import, and within five minutes is clicking
through a request to see the exact queries, jobs, and exceptions it produced —
in dev with full detail, in prod with redaction and a gate.

## Brand Personality

Opinionated, developer-first, robust. This library has a clear point of view:
observability should be correlated (not scattered logs), non-blocking (never slow
the app), pluggable (your DB, your storage, your watchers), and safe to run in
production (redaction and gating are defaults, not afterthoughts). The docs reflect
that confidence: show the recommended setup, lead with code, and don't hedge.

## Anti-references

- "Just pipe logs to Grafana" answers — this is about *correlated entries you click
  into*, not time-series aggregates. We complement metrics/tracing, not replace them.
- Heavyweight agents that require running collectors, sidecars, or a separate
  service just to see your own requests.
- A capture layer that blocks the request thread or grows memory unboundedly under
  load. Robust-or-nothing on the hot path.
- Vendor lock-in: a fixed database, a bundled-and-unavoidable UI, or hooks that
  third parties can't reach. Every built-in is built on the same public SPI.

## Design Principles

1. **Correlation first.** The unit of value is the *batch* — one request and
   everything it caused. Any feature that doesn't help you follow a flow end to end
   is secondary.
2. **Never touch the hot path.** Capture is O(1) and synchronous; all serialization,
   redaction, and I/O are deferred. A telescope bug must never break or slow the app.
3. **Pluggable to the core.** Storage, watchers, entry types, and tags are public
   contracts. The defaults are reference implementations of those contracts, not
   privileged internals.
4. **Safe in production by default.** Redaction always runs, the API gate denies in
   production until you opt in, and retention pruning is built in. Dev richness is a
   config relaxation, not a different code path.
5. **Copy-paste ready.** Every guide is a complete, runnable setup — core + an
   adapter + the module import — not pseudocode.

## Accessibility & Inclusion

The optional dashboard ships sensible defaults: sufficient contrast, keyboard
navigation, semantic headings, readable code/SQL blocks in light and dark themes.
No formal WCAG target, but no color-only signaling for entry status (use icon +
label, not just red/green).
