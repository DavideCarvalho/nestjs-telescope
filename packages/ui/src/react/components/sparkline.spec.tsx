import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline, sparklinePoints } from './sparkline.js';

describe('sparklinePoints', () => {
  it('maps values to scaled points (max at top, zero at bottom)', () => {
    expect(sparklinePoints([0, 10], 10, 10)).toBe('0.0,10.0 10.0,0.0');
  });
  it('returns empty for no values', () => {
    expect(sparklinePoints([], 10, 10)).toBe('');
  });
});

describe('Sparkline', () => {
  it('renders an svg with a polyline', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.querySelector('polyline')).toBeTruthy();
  });
});
