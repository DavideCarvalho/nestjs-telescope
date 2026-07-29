import type { Config } from 'tailwindcss';

/**
 * shadcn's semantic class names (`bg-background`, `text-muted-foreground`,
 * `border-border`, …) are wired here to the Aviary console tokens declared in
 * `src/app/index.css`, NOT to shadcn's own defaults. Vendored primitives under
 * `src/react/ui/` therefore inherit the console palette with no per-component
 * theming, and flip with the `.light` root class for free.
 *
 * Token source of truth: ../../AVIARY-UI.md
 */

/**
 * Declare a token as a colour FUNCTION so Tailwind hands the opacity modifier over
 * instead of dropping the rule.
 *
 * This is the Tailwind 3 opacity trap, and it is not a cosmetic bug: a plain
 * `'var(--panel)'` value makes `bg-panel/40` emit **no CSS rule at all** — not a
 * wrong background, none — which is indistinguishable from a background nobody
 * intended. Taking the modifier here and applying it with `color-mix` keeps
 * `bg-panel/40`, `border-line/60` and friends working.
 *
 * Copied verbatim from AVIARY-UI.md — do not re-derive.
 */
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string | undefined }): string =>
    opacityValue === undefined
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Aviary tokens, addressable directly.
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        live: token('--live'),

        /*
         * The brand hue. Deliberately NOT called `accent`: shadcn's `accent` is a
         * muted HOVER SURFACE, and wiring it to `--accent` puts solid brand-coloured
         * blocks under every hover. See AVIARY-UI.md.
         */
        brand: { DEFAULT: token('--accent'), foreground: token('--bg') },

        /*
         * shadcn's semantic names, mapped per the AVIARY-UI.md table. Three of these
         * are traps because the two vocabularies reuse the same word:
         *   - shadcn `accent` is a subtle HOVER SURFACE, not the brand hue.
         *   - shadcn `muted` is a SURFACE; Aviary `--muted` is dim TEXT, which is
         *     why it lands on `muted-foreground` rather than `muted`.
         */
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),
        background: token('--bg'),
        foreground: token('--text'),
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },
        secondary: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--panel-2'), foreground: token('--muted') },
        accent: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
      },
    },
  },
  plugins: [],
} satisfies Config;
