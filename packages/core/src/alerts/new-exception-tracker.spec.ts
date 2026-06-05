// packages/core/src/alerts/new-exception-tracker.spec.ts
import { describe, expect, it } from 'vitest';
import { NewExceptionTracker } from './new-exception-tracker.js';

const WINDOW = 60_000;

describe('NewExceptionTracker', () => {
  it('reports the first occurrence of a family as new', () => {
    const tracker = new NewExceptionTracker();
    expect(tracker.observe('fam-A', 1_000, WINDOW)).toBe(true);
  });

  it('does NOT report a repeat within the window as new', () => {
    const tracker = new NewExceptionTracker();
    tracker.observe('fam-A', 1_000, WINDOW);
    expect(tracker.observe('fam-A', 1_000 + WINDOW - 1, WINDOW)).toBe(false);
  });

  it('reports as new again once the window has elapsed', () => {
    const tracker = new NewExceptionTracker();
    tracker.observe('fam-A', 1_000, WINDOW);
    expect(tracker.observe('fam-A', 1_000 + WINDOW, WINDOW)).toBe(true);
  });

  it('caps the map and evicts the oldest inserted family', () => {
    const tracker = new NewExceptionTracker(2);
    tracker.observe('fam-A', 1, WINDOW);
    tracker.observe('fam-B', 2, WINDOW);
    tracker.observe('fam-C', 3, WINDOW); // evicts fam-A
    expect(tracker.size).toBe(2);
    // fam-A was evicted, so it is "new" again.
    expect(tracker.observe('fam-A', 4, WINDOW)).toBe(true);
  });
});
