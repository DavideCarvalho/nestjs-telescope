/** A controllable clock for deterministic tests. */
export class FakeClock {
  constructor(private current = 0) {}

  /** Returns the current epoch-ms; pass as the Recorder's `now`. */
  now = (): number => this.current;

  /** Advance the clock by `ms`. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Set the clock to an absolute epoch-ms. */
  set(ms: number): void {
    this.current = ms;
  }
}
