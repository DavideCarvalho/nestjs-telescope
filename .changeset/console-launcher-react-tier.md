---
'@dudousxd/nestjs-telescope-ui': minor
---

**React tier for the console launcher: `useOpenTelescopeConsole` and `<OpenTelescopeConsoleButton>`, exported from `@dudousxd/nestjs-telescope-ui/react`.**

The headless `openTelescopeConsole` gave hosts the mint-then-navigate call; every host then wrote the
same three lines of React around it — an `isPending` flag, an error slot, and a button that has to
remember not to fire twice. Three tiers now, pick the one that fits and drop a level when it stops
fitting:

```tsx
import {
  OpenTelescopeConsoleButton,
  useOpenTelescopeConsole,
  openTelescopeConsoleMutationOptions,
} from '@dudousxd/nestjs-telescope-ui/react';

// 1. drop-in
<OpenTelescopeConsoleButton className="btn btn-primary" headers={authHeaders} />

// 2. state only, your markup
const { open, isPending, error, reset } = useOpenTelescopeConsole({ headers: authHeaders });

// 3. openTelescopeConsole(...) from `/client` — no React at all
```

- `open()` **never rejects**; the refusal lands in `error` as a `ConsoleSessionError` (with its
  `status` and `url`). It deliberately does not clear `isPending` on success, because the navigation
  is already underway and flipping back to idle flickers "ready to click again" on a page that is
  leaving.
- `<OpenTelescopeConsoleButton>` is **unstyled on purpose** — a bare `<button>` that forwards
  `className`/`style`/every other button prop, so it inherits the host's design system instead of
  importing CSS that fights it. It renders inside the host app, not inside Telescope's own bundle.
  It disables itself and sets `aria-busy` while in flight, and renders the refusal as
  `<p role="alert">` by default: a launcher that silently does nothing reads as broken rather than
  forbidden. `renderError` substitutes that node; `renderError={null}` opts out entirely.
- `openTelescopeConsoleMutationOptions()` returns the `{ mutationKey, mutationFn }` shape
  `useMutation` takes, so a host already on TanStack Query gets the launcher in its cache, devtools
  and error handling with no adapter — and this package still never imports `@tanstack/react-query`.

React stays an optional peer dependency: a host that only mounts the NestJS module pulls none of
this in. Additive only; nothing existing changes.
