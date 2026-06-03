import { render, screen } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ENTRY_TYPES } from '../react/index.js';
import { DashboardLayout } from './dashboard-layout.js';

function renderLayout() {
  return render(
    <HashRouter>
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    </HashRouter>,
  );
}

describe('DashboardLayout', () => {
  it('renders the top-level nav and the page children', () => {
    renderLayout();
    expect(screen.getByText('child')).toBeTruthy();
    for (const label of ['Overview', 'Entries', 'Pulse', 'Queues']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
  });

  it('renders a Watchers nav item per entry type with a hash href to its filtered list', () => {
    renderLayout();
    expect(screen.getByText('Watchers')).toBeTruthy();
    for (const type of ENTRY_TYPES) {
      const link = screen.getByRole('link', { name: type.label });
      expect(link.getAttribute('href')).toBe(`#/entries/${type.id}`);
    }
  });
});
