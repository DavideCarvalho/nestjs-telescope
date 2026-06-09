---
"@dudousxd/nestjs-telescope-ui": minor
---

Add the Inertia debug panel. The dashboard now renders a rich detail view for
`inertia` entries (`InertiaBody`): rendered component header with status/partial
badges, a red version-mismatch (409) callout, the partial-reload Kept/Excluded
columns, prop classification chips (shared/final/optional/once/merge/deep-merge
with `matchPropsOn` annotations), deferred groups, the resolved-props tree
(showing the Recorder's redaction/truncation markers verbatim), history flags and
page size. Adds `InertiaBadge` (409 / partial / deferred / size chips), an
`inertia` list summary, and an `Inertia` nav tab that self-hides until the
`InertiaWatcher` is installed.
