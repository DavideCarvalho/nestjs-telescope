---
'@dudousxd/nestjs-telescope': minor
'@dudousxd/nestjs-telescope-ui': minor
---

Add a **Dumps** dev tool. Call `telescopeDump(value, 'label')` anywhere in your
code (no dependency injection at the call site) and the value shows up in a new
"Dumps" tab in the dashboard — a request-correlated alternative to
`console.log`. `telescopeDump` forwards to a module-level sink that
`TelescopeService` wires on construction and detaches on shutdown (it is a
no-op until wired, so importing it in shared code never crashes outside a
Telescope-enabled app). `TelescopeService.dump(value, label?)` records a `dump`
entry whose `value` is redacted by the Recorder like any other content and
correlated to the active batch. Core exports `telescopeDump`, `setTelescopeDump`,
`DumpContent`, and `EntryType.Dump`. The UI gains a `dump` entry type, a detail
view that renders the label and pretty-printed JSON value (guarding
non-serializable values), and a table summary showing the label or a value
preview.
