// packages/core/src/fleet/worker-marks.ts
//
// What tells the fleet a process without an HTTP server is a long-running worker, and what it is.
// Kept on a global slot, so a library can mark its workers without depending on telescope (or on
// the copy of it the app loaded): `globalThis[Symbol.for('@dudousxd/nestjs-telescope:fleetWorkers')]`.

const SLOT = Symbol.for('@dudousxd/nestjs-telescope:fleetWorkers');

type Marks = Map<string, number>;

function marks(): Marks {
  const slot = globalThis as unknown as Record<symbol, Marks | undefined>;
  let current = slot[SLOT];
  if (!(current instanceof Map)) {
    current = new Map();
    slot[SLOT] = current;
  }
  return current;
}

/**
 * Says this process runs a long-running worker named `name` (`bullmq`, `durable`). In a process
 * without an HTTP server, the fleet then names its instance after it (`bullmq+durable` for
 * several). Returns the release (call it when the worker stops); marks stack.
 */
export function markFleetWorker(name: string): () => void {
  const all = marks();
  all.set(name, (all.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (all.get(name) ?? 1) - 1;
    if (count <= 0) all.delete(name);
    else all.set(name, count);
  };
}

/** The workers marked in this process, sorted. */
export function markedFleetWorkers(): string[] {
  return [...marks().keys()].sort();
}
