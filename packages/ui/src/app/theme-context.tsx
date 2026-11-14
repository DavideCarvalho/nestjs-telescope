import type { ReactNode } from 'react';
import { ThemeProvider as KitThemeProvider, type Theme } from '../aviary-kit/theme';

export { type Theme, useTheme } from '../aviary-kit/theme';

/** Telescope's accent (magenta); light mode darkens it as ink (`--aviary-accent-ink`). */
export const TELESCOPE_ACCENT = '#e879f9';

/** Where the theme is remembered (one key per Aviary console). */
export const THEME_STORAGE_KEY = 'aviary-telescope-theme';

/** Where telescope remembered the theme before the Aviary console kit. Read once, as a default. */
export const LEGACY_THEME_STORAGE_KEY = 'telescope-theme';

function legacyTheme(): Theme {
  try {
    return window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * The console's theme: the kit's ThemeProvider (`html.light` / `html.dark` + `data-theme`, so the
 * portalled overlays theme too) with telescope's storage key and accent. A theme chosen before the
 * kit (`telescope-theme`) is kept as the default until the viewer toggles again.
 */
export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <KitThemeProvider
      storageKey={THEME_STORAGE_KEY}
      accent={TELESCOPE_ACCENT}
      defaultTheme={legacyTheme()}
    >
      {children}
    </KitThemeProvider>
  );
}
