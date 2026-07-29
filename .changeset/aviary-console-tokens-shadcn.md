---
'@dudousxd/nestjs-telescope-ui': minor
---

Adopt the Aviary console design tokens and a vendored shadcn-on-Base-UI primitive layer.

The dashboard was authored against hardcoded Tailwind `zinc`/`emerald` utilities — the only
Aviary console with no token vocabulary at all. It now declares the canonical tokens from
`AVIARY-UI.md` (`--bg`, `--panel`, `--panel-2`, `--line`, `--line-soft`, `--text`, `--muted`,
`--good`, `--warn`, `--bad`, `--live`, `--accent`) and consumes them through Tailwind semantic
colours, so it reads as a sibling of the agent, durable and media consoles rather than a stranger.

- **Light mode actually works.** It was a block of `.light .bg-zinc-900 { … }` overrides that
  covered only the utilities someone had remembered to list, leaving mid-grey panels and
  unreadable status text. The tokens are now declared twice — dark under `:root`, light under
  `.light` — so every token-based surface, border, label and status flips with the theme.
- **Telescope's accent is magenta** (`#e879f9`). Its de-facto accent was emerald-400, which is
  byte-identical to `--good`: the same hue meant both "healthy" and "interactive", side by side
  on the Overview page. Magenta clears `--good`, `--warn`, `--bad`, `--live`, agent's violet and
  media's cyan.
- **Vendored shadcn primitives** under `src/react/ui/` on Base UI — `Button`, `Badge`, `Input`,
  `Table`, `Select`, `Tabs`, `Tooltip`, `Dialog` — wired so shadcn's semantic classes resolve to
  the Aviary tokens. Note that shadcn's `accent` is a *hover surface*, so the brand hue is
  exposed as `brand`/`--accent` and never as `bg-accent`.
- The command palette and the queue job drawer are now one `Dialog` implementation instead of
  two hand-rolled overlays, and the two native `<select>` popups (which the OS drew, unthemed)
  are now themable listboxes.

`cacheBadge()` and `inertiaBadges()` gain a `variant` field naming the semantic `Badge` variant.
`className` is unchanged in shape and still returned, so existing callers keep working; prefer
`variant` in new code.

Also fixes a long-standing packaging bug this work's bundle check surfaced: the `./react` barrel
reaches `recharts`, `react-router-dom` and `reflect-metadata`, none of which this package declared
— the exact failure that once broke a host's client build. They are now declared as optional peer
dependencies. `@base-ui-components/react`, `class-variance-authority`, `clsx` and `tailwind-merge`
are `dependencies`, because this package publishes React source that hosts bundle. A new
`published-graph.spec.ts` bundles each published entry with esbuild and asserts every package it
reaches is declared, so this cannot regress silently.
