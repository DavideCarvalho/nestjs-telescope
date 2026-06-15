import { cloneElement, isValidElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  function Mock({ children }: { children: React.ReactNode }): JSX.Element {
    return <div>{isValidElement(children) ? cloneElement(children, { width: 600, height: 300 }) : children}</div>;
  }
  return { ...actual, ResponsiveContainer: Mock };
});

import { PanelView } from './panel-renderer.js';

describe('PanelView (pure render from resolved data)', () => {
  it('renders a stat panel with a percent format', () => {
    render(<PanelView panel={{ kind: 'stat', title: 'Success rate', data: { provider: 'p' }, format: 'percent' }} data={{ value: 0.97 }} />);
    expect(screen.getByText('Success rate')).toBeTruthy();
    expect(screen.getByText('97%')).toBeTruthy();
  });

  it('renders a table panel with deep-linked rows', () => {
    render(
      <PanelView
        panel={{ kind: 'table', title: 'Recent failures', data: { provider: 'p' },
          columns: [{ key: 'workflow', label: 'Workflow' }, { key: 'runId', label: 'Run', link: { href: '/durable/runs/{runId}' } }] }}
        data={{ rows: [{ workflow: 'checkout', runId: 'r1' }] }}
      />,
    );
    expect(screen.getByText('checkout')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'r1' });
    expect(link.getAttribute('href')).toBe('/durable/runs/r1');
  });
});
