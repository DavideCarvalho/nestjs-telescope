# Aviary console UI — the canonical set

Four consoles ship in four separate repos:

| console | repo | mount |
|---|---|---|
| agent governance | `nestjs-agent/packages/dashboard` | `/ai-gateway` |
| durable workflows | `nestjs-durable/packages/dashboard` | `/durable` |
| media | `nestjs-media/packages/dashboard` | `/media` |
| telescope | `nestjs-telescope/packages/ui` | `/telescope` |

They should look like siblings, not clones and not strangers. **This file is the source of truth they
are copied from, and it is itself copied verbatim into all four repos** at `docs/AVIARY-UI.md`, so
whoever opens any one of them finds it without having to know a sibling repo exists.

That means the spec has four copies and can drift exactly like the tokens did. So it is checkable —
run this before trusting it:

```sh
md5sum ~/personal/oss/nestjs/{nestjs-agent,nestjs-durable,nestjs-media,nestjs-telescope}/docs/AVIARY-UI.md
```

Four identical hashes or it is already lying to you. Any edit propagates to all four in the same
session; a copy that only landed in one repo is worse than no copy, because it reads as authoritative. There is deliberately no shared npm package yet — the cost of a fourth
publish-ordering dependency across four repos was judged higher than the cost of copying. That
trade only holds while the copies stay honest, which is what this file exists to make possible.

> **If you change anything here, update all four consoles in the same session.** A change that
> lands in one console and not the others is how the previous drift happened, and it is invisible
> until someone puts two screenshots side by side.

## Why this file exists — the drift it is fixing

Before this, the identity lived only as copy-paste, and had already come apart:

```
durable   --accent:#34d399  --bg:#09090b  --panel:#0c0c0f  --text:#e7e7ea
media     --accent:#34d399  --bg:#09090b  --panel:#0c0c0f  --text:#e7e7ea   ← byte-identical
agent     --accent:#a78bfa  --bg:#08080b  --panel:#0d0d12  --text:#e8e8ee   ← drifted on all six
telescope  (no tokens at all — a different approach entirely)
```

The accent difference is a decision. `#08080b` vs `#09090b` and `#e8e8ee` vs `#e7e7ea` are not —
nobody chose those, they are a hand-copy that slipped. The neutrals below are the durable/media
values, which were the majority and the ones that had not moved.

## The rule

**The neutrals, the type scale, the spacing and the primitives are identical everywhere. The accent
is the one variable, one per console.** That is what makes them read as one family while telling
you at a glance which console you are in.

## Tokens

```css
:root {
  /* ── Shared. Identical in all four consoles. Do not tune per console. ── */
  --bg: #09090b;
  --panel: #0c0c0f;
  --panel-2: #101017;      /* elevated surface: modal/dialog, drawer, popover, menu */
  --line: #1c1c22;
  --line-soft: #16161a;
  --text: #e7e7ea;
  --muted: #76767f;

  /* Status. Semantic, never decorative — see the accent note below. */
  --good: #34d399;
  --warn: #fbbf24;
  --bad: #f87171;
  --live: #60a5fa;         /* in flight: an upload running, a workflow mid-execution */
  --selected: #a1a1aa;     /* "this row/node is the one you picked" — neither status nor brand */

  /* ── Per console. This is the ONLY line that differs between them. ── */
  --accent: #a78bfa;       /* agent: violet */
}
```

Per-console accents:

| console | `--accent` | |
|---|---|---|
| agent | `#a78bfa` | violet |
| durable | `#a3e635` | lime |
| media | `#22d3ee` | cyan |
| telescope | `#e879f9` | magenta (light mode `#a21caf`) |

All four are decided and shipped. Durable and media moved off emerald for the reason in the next
section; telescope had no accent at all before, so magenta was assigned rather than changed.

### `--good` used as an accent is usually a missing token, not a colour preference

Durable's graph selection ring was hard-coded emerald, and so was its accent. That is the same
mistake twice: a **selected / active** affordance is neither status nor brand, and with no slot for
it people reach for whichever hue is nearest — which is `--good`. Three of the four consoles have
one. Hence `--selected` above; use it before reaching for the accent.

### The accent wheel, with degrees

It is effectively full, and a console's *local* hues consume space too — which is why durable had
far less room than a four-row accent table suggests.

| ° | token / console | hex |
|---|---|---|
| 0 | `--bad` | `#f87171` |
| 25 | durable "no worker" | |
| 45 | `--warn` | `#fbbf24` |
| **82** | **durable** | `#a3e635` lime |
| 160 | `--good` | `#34d399` |
| 187 | **media** | `#22d3ee` cyan |
| 217 | `--live` | `#60a5fa` |
| 239 | durable "sleeping" | |
| 258 | **agent** | `#a78bfa` violet |
| 300 | **telescope** | `#e879f9` magenta |
| 347 | durable "dead" | |

Console #5 should start from this table rather than re-deriving it.

### The accent/status collision, which needs deciding

`--good` is `#34d399`, and that is **exactly** the accent durable and media use today. In a console
where green already means "healthy", making green also mean "this is interactive" gives one colour
two jobs, and the reader has to use position to tell them apart. It is worst precisely where it
matters most: a run list where green rows mean success and green text means a link.

Agent does not have this problem — violet against a green/amber/red status set is unambiguous.

Durable and media were shipping this and had no way to see it, because nothing was comparing the four.
Both have moved off emerald — durable to lime, media to cyan — each chosen against the wheel above and
reviewed with screenshots of the collision in situ rather than in the abstract.

## Component layer — shadcn on Base UI

shadcn is copy-in source, not a dependency, so "each console owns its copy" is the model working as
intended. Each console vendors the primitives it needs under `src/app/ui/`, generated against the
tokens above so `bg-background` etc. resolve to the Aviary neutrals rather than shadcn's defaults.

**Primitive layer is Base UI, not Radix.** Initialise shadcn against Base UI in every console, and
use it uniformly — Dialog included. Do not hand-roll a primitive that shadcn ships, and do not mix
Radix in alongside it; one primitive layer across four consoles is the whole point.

**Overlays stack by ordinary `z-index`, not the top layer.** Toasts deliberately paint *over* modals
(media has them at `z-[60]` for exactly this). A native `<dialog>` opened with `showModal()` renders
in the browser's top layer, which no `z-index` can sit above — so it would silently hide a toast
fired while a modal is open. Base UI keeps overlays in normal flow and that ordering keeps working;
do not reintroduce a top-layer element beneath something that has to outrank it.

Peer packages per console: `@base-ui-components/react`, `class-variance-authority`, `clsx`,
`tailwind-merge`. **Declare every one explicitly**, and put them in the right section:

The deciding question is **not** "does it ship an SPA" — it is **"is the package reachable from a
published entry?"** Telescope is both: a pre-bundled SPA *and* a `./react` barrel hosts import.

- **Not reachable from any published entry** → `devDependencies`. A host installs nothing extra.
- **Reachable from a published entry** → `dependencies` (or an optional peer).

Do not answer this by reading imports. **Bundle each published entry and inspect the module graph** —
telescope now has `src/react/published-graph.spec.ts` doing exactly that, and it is worth copying.
When it was first run it caught the original incident *still live on `main`*: `recharts`,
`react-router-dom` and `reflect-metadata` reachable from published entries and never declared, years
after they broke a host's client build once already. `grep` had not found it. A bundler did.

That distinction is the actual lesson of the `telescope-ui` incident, which is often misremembered:
what broke a host's client build was a *published* entry re-exporting an undeclared `recharts` and
`react-router-dom`. Bundled SPA code cannot cause that. Get the section right rather than reciting
the story.

### `--accent` means brand here. shadcn's `accent` means hover surface.

They are different things wearing the same word, and vendoring shadcn source verbatim wires
`hover:bg-accent` to the brand hue — producing solid brand-coloured blocks under every hover.
Map deliberately: shadcn's `accent`/`accent-foreground` are a **muted hover surface** (`--panel-2`
or a `color-mix` of `--line`), and the Aviary brand hue is its own class (`bg-brand`, `text-brand`,
or keep it as `var(--accent)` directly). Check this the moment the first Button lands, not after
four consoles have green hover blocks.

## The Tailwind 3 opacity trap — check this in every console

**`bg-[var(--accent)]/10` emits no rule at all.** Tailwind 3 cannot apply an opacity modifier to an
arbitrary `var()` colour, so it does not produce a wrong background — it produces *none*, which is
indistinguishable from a background nobody intended. The agent console shipped like this from the
day it was written: the active nav pill, the Approve/Reject buttons and the failure panels' borders
were all rendering untinted, and one of them showed Tailwind preflight's `#e5e7eb` white border
through the dropped rule. Nothing in review catches this; the class name reads correctly.

The fix is to declare tokens as colour **functions**, so Tailwind hands over the modifier:

```ts
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string | undefined }): string =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}
```

Then `colors: { background: token('--bg'), … }`. Copy it verbatim; do not re-derive it.

## shadcn name → Aviary token

Three of these are traps, because shadcn and Aviary use the same word for different things. Map the
whole set deliberately rather than component by component:

| shadcn | Aviary | note |
|---|---|---|
| `background` / `foreground` | `--bg` / `--text` | |
| `card` | `--panel` | the standard panel surface |
| `popover` / `secondary` | `--panel-2` | elevated: dialog, drawer, menu |
| **`accent`** | **`--panel-2`** | ⚠ shadcn `accent` = subtle HOVER SURFACE, not brand |
| **`muted`** | **`--panel-2`** | ⚠ shadcn `muted` = a surface |
| **`muted-foreground`** | **`--muted`** | ⚠ Aviary `--muted` is dim TEXT |
| `destructive` | `--bad` | |
| `border` / `input` | `--line` | |
| `ring` | `--accent` | |
| *(new)* `brand` | `--accent` | the Aviary brand hue gets its own name |

## Base UI gotchas that compile green and fail at runtime

- **`Dialog.Popup` must be inside `Dialog.Portal`.** Base UI throws at *click* time, not build time,
  so this ships and only fails when a user opens the dialog — taking the tree with it.
- **State attributes differ per primitive**: Tabs uses `data-active`, Select uses `data-selected`,
  menus use `data-highlighted`, overlays use `data-open`/`data-closed`. Styling the wrong one
  compiles clean and silently never matches.
- **`enabled:hover:` is a trap.** `:enabled` only matches form controls, so every hover dies the
  moment `render` turns a Button into an `<a>`. Use plain `hover:` + `disabled:pointer-events-none`.
- Base UI animates via `data-starting-style` / `data-ending-style` on ordinary transitions, so
  `tailwindcss-animate` is not needed.
- `useRender` covers shadcn's `asChild`/Slot pattern; `Dialog.Popup`'s `initialFocus` covers initial
  focus better than hand-rolling it.

## Light mode — the token block is not dark-only

Telescope has a user-facing light mode, and it was broken before this work: implemented as a block of
`.light .bg-zinc-900 { … }` overrides covering only the classes someone remembered to list, leaving
mid-grey panels and unreadable status text. That is not a reason to skip the dark set — it is the
argument for it. **Author the tokens as a redeclarable set, not one `:root` block**: declare them in
`:root` for dark and again under `.light`, and everything token-based flips for free.

Also: **the theme class must be on `<html>`, not on a provider's container.** Base UI portals
overlays to `document.body`, so a class scoped to a React subtree leaves every dialog, popover and
command palette outside the theme — telescope rendered a dark command palette on a white page.

## Categorical data hues are not tokens

A console may carry a palette that encodes *data* rather than state — telescope has 16 hues for
entry types (nav dots, chart series, bar fills). Those are out of scope for token migration; a
mechanical sweep will happily eat them and destroy the encoding.

It also has a consequence for accents: with sixteen hues claimed, "pick an accent that avoids
`--good`" stops being trivially satisfiable. Claimed so far — bad 0°, warn 45°, good 160°, media
cyan 187°, live 217°, agent violet 258°, telescope magenta 300°. Check the wheel before proposing.

## Still open

- **A second decorative hue.** The agent console had `--accent-2` for a gradient and folded it into
  `--live`. If a console legitimately needs two brand-ish hues, the canonical set has no slot for it.
- **SPA-only packages already in `dependencies`.** `recharts` in `nestjs-agent/packages/dashboard` is
  SPA-only but sits in `dependencies`, against the rule above. The rule should be applied to existing
  entries, not just new ones.

## Adopting a status token means auditing the concept, not adding a variable

Durable adopted `--live` and immediately exposed an inconsistency nothing could lint: a running step
was blue in the run list and the step badges, and **amber in the workflow graph** — where amber is
`--warn`'s job, meaning suspended. The same concept had two colours, one of which was actively
misleading. When you add a status token, find every place that concept is already coloured.

## After `pnpm add`, read the lockfile diff before pushing

In these repos `pnpm add` can silently re-resolve unrelated peer sets. Durable's first attempt
dropped `(class-transformer)(class-validator)` from `@nestjs/common`/`@nestjs/core` lockfile keys,
lost `lightningcss` from vite and swapped `@swc/core` out of tsup — putting two `@nestjs/core`
instances in the graph and failing a `RouterModule` test the branch never touched.

**The lockfile diff should be purely additive.** If it has removed lines, restore it from the
default branch and regenerate with `--lockfile-only`.
