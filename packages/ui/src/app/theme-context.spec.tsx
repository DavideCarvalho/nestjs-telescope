import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme-context.js';

const STORAGE_KEY = 'telescope-theme';

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

function ToggleHarness(): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
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

describe('ThemeProvider', () => {
  beforeEach(() => {
    installMemoryStorage();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to dark and applies the dark root class', () => {
    renderProvider();
    const root = screen.getByTestId('telescope-root');
    expect(root.className).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button').textContent).toBe('dark');
  });

  it('toggle flips the root class and persists to localStorage', () => {
    renderProvider();
    fireEvent.click(screen.getByRole('button'));
    const root = screen.getByTestId('telescope-root');
    expect(root.className).toBe('light');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('light');

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('telescope-root').className).toBe('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  it('restores the persisted theme from localStorage on mount', () => {
    window.localStorage.setItem(STORAGE_KEY, 'light');
    renderProvider();
    expect(screen.getByTestId('telescope-root').className).toBe('light');
    expect(screen.getByRole('button').textContent).toBe('light');
  });
});
