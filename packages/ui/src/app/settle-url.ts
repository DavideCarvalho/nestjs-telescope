/**
 * Test helper: nuqs flushes URL writes on a short throttle (50ms), from a queue that outlives the
 * component. Wait it out after each test that renders a page with URL filters, so a write queued
 * at the end of one test does not land in the next one's URL. Use as `afterEach(settleUrlWrites)`.
 */
export function settleUrlWrites(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 80));
}
