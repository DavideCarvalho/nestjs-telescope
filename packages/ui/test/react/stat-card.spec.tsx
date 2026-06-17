import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatCard } from '../../src/react/components/extensions/stat-card.js';

describe('StatCard', () => {
  it('renders a positive delta with an up arrow', () => {
    render(<StatCard label="Success" value="98.7%" delta={1.2} deltaLabel="1.2pp" />);
    expect(screen.getByText(/1\.2pp/)).toBeTruthy();
    expect(screen.getByText(/▲/)).toBeTruthy();
  });

  it('colors the accent red when currentValue crosses the bad threshold', () => {
    const { container } = render(
      <StatCard
        label="p95"
        value="3.0s"
        currentValue={3000}
        thresholds={{ warn: 1500, bad: 2500, direction: 'up-bad' }}
      />,
    );
    expect(container.querySelector('[data-health="bad"]')).toBeTruthy();
  });
});
