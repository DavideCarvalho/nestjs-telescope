import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_THEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from './theme-context.js';

// jsdom here doesn't ship a fully-functional localStorage; install a tiny
// in-memory stub so persistence/restore is exercised deterministically.
function installMemoryStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
}

function ToggleHarness(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

function renderProvider() {
  return render(
    <ThemeProvider>
      <ToggleHarness />
    </ThemeProvider>,
  );
}

const html = () => document.documentElement;

describe('ThemeProvider', () => {
  beforeEach(() => {
    installMemoryStorage();
  });
  afterEach(() => {
    window.localStorage.clear();
    html().className = '';
  });

  it('defaults to dark, on <html> (so portalled overlays theme too), with the accent', () => {
    renderProvider();
    expect(html().classList.contains('dark')).toBe(true);
    expect(html().dataset.theme).toBe('dark');
    expect(html().style.getPropertyValue('--aviary-accent')).toBe('#e879f9');
    expect(screen.getByRole('button').textContent).toBe('dark');
  });

  it('toggle flips the root class and persists to localStorage', () => {
    renderProvider();
    fireEvent.click(screen.getByRole('button'));
    expect(html().classList.contains('light')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(screen.getByRole('button'));
    expect(html().classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('restores the persisted theme from localStorage on mount', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    renderProvider();
    expect(html().classList.contains('light')).toBe(true);
    expect(screen.getByRole('button').textContent).toBe('light');
  });

  it('keeps a theme chosen before the kit (`telescope-theme`) as the default', () => {
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'light');
    renderProvider();
    expect(screen.getByRole('button').textContent).toBe('light');
  });
});
