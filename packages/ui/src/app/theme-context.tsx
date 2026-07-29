import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'telescope-theme';
const DEFAULT_THEME: Theme = 'dark';

interface ThemeValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/** Safe localStorage read — guards SSR / disabled storage; defaults to dark. */
function readStoredTheme(): Theme {
  if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function persistTheme(theme: Theme): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore quota / private-mode failures; the in-memory theme still applies.
  }
}

/**
 * Theme provider: holds `theme` (dark default), persists to localStorage, and
 * applies the active theme as a `light`/`dark` class BOTH on the container it
 * renders and on `<html>`. The token definitions live in `index.css`.
 *
 * The `<html>` half is not redundant. Every overlay in the console — dialog,
 * select popup, tooltip — is portalled to `document.body`, which is *outside*
 * this provider's container. Scoping the class to the container alone leaves
 * portalled content reading the `:root` (dark) tokens, so in light mode the
 * command palette renders as a dark box on a white page. Nothing but a browser
 * catches that: it typechecks, it builds, and the components are correct.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return next;
    });
  }, []);

  // Restore from storage once on mount (covers the SSR-default case where the
  // initial state could not read window).
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  // Mirror the theme onto <html> so portalled overlays inherit the same tokens.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('dark', theme === 'dark');
    return () => {
      root.classList.remove('light', 'dark');
    };
  }, [theme]);

  const value = useMemo<ThemeValue>(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return (
    <ThemeContext.Provider value={value}>
      <div className={theme} data-theme={theme} data-testid="telescope-root">
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within a ThemeProvider');
  return value;
}
