import { fireEvent, render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CommandPalette, PALETTE_ACTIONS, filterActions, usePalette } from './command-palette.js';

function Harness(): JSX.Element {
  const { open, setOpen } = usePalette();
  return (
    <HashRouter>
      <button type="button" onClick={() => setOpen(true)}>
        trigger
      </button>
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </HashRouter>
  );
}

function renderHarness() {
  window.location.hash = '';
  return render(<Harness />);
}

describe('command palette actions', () => {
  it('includes every entry type and the static pages', () => {
    const labels = PALETTE_ACTIONS.map((action) => action.label);
    expect(labels).toContain('Overview');
    expect(labels).toContain('Pulse');
    expect(labels).toContain('Traces');
    expect(labels).toContain('Requests');
    expect(labels).toContain('Queries');
  });

  it('filters by case-insensitive substring', () => {
    const result = filterActions(PALETTE_ACTIONS, 'over');
    expect(result.map((action) => action.label)).toContain('Overview');
    expect(result.every((action) => action.label.toLowerCase().includes('over'))).toBe(true);
  });
});

describe('CommandPalette', () => {
  it('opens on Cmd+K', () => {
    renderHarness();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens on Ctrl+K', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens from the trigger badge', () => {
    renderHarness();
    fireEvent.click(screen.getByText('trigger'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('typing filters the action list', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'pulse' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toBe('Pulse');
  });

  it('Enter on the highlighted action navigates to its hash route and closes', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'pulse' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/pulse');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ArrowDown moves the highlight before Enter navigates', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.change(input, { target: { value: 'queue' } });
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(window.location.hash).toBe('#/queues/metrics');
  });

  it('Escape closes the palette', () => {
    renderHarness();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = screen.getByLabelText('Search actions');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
