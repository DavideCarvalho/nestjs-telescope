import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { QueueCounts } from '../../../client/index.js';
import { QueueStateTabs } from './QueueStateTabs.js';

const counts: QueueCounts = {
  waiting: 3,
  active: 1,
  delayed: 0,
  failed: 7,
  completed: 42,
  paused: 0,
};

describe('QueueStateTabs', () => {
  it('marks the selected state with Base UI’s `data-active`, not `data-selected`', () => {
    // Base UI's Tabs exposes `data-active`; Select uses `data-selected` and menus use
    // `data-highlighted`. Styling the wrong attribute compiles clean, passes typecheck
    // and silently never matches, so the active tab just stops looking active. Assert
    // the attribute the stylesheet actually keys off.
    render(<QueueStateTabs counts={counts} state="failed" onState={() => {}} />);

    const failed = screen.getByRole('tab', { name: /failed/i });
    expect(failed.hasAttribute('data-active')).toBe(true);
    expect(screen.getByRole('tab', { name: /waiting/i }).hasAttribute('data-active')).toBe(false);

    // …and that the stylesheet keys off that same attribute. Asserting the DOM alone
    // would still pass if the variant were written `data-[selected]:`, which is the
    // mistake this guards.
    expect(failed.className).toContain('data-[active]:');
    expect(failed.className).not.toContain('data-[selected]:');
  });

  it('reports the picked state', () => {
    const onState = vi.fn();
    render(<QueueStateTabs counts={counts} state="waiting" onState={onState} />);

    fireEvent.click(screen.getByRole('tab', { name: /completed/i }));
    expect(onState).toHaveBeenCalledWith('completed');
  });

  it('shows each state’s count, and zero when counts are missing', () => {
    render(<QueueStateTabs counts={undefined} state="waiting" onState={() => {}} />);
    expect(screen.getByRole('tab', { name: /waiting/i }).textContent).toContain('0');
  });
});
