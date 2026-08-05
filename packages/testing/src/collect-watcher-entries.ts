import {
  type BatchHandle,
  type RecordInput,
  type Watcher,
  type WatcherContext,
  captureException,
  resolveConfig,
} from '@dudousxd/nestjs-telescope';

export interface CollectedWatcher {
  recorded: RecordInput[];
  context: WatcherContext;
}

/** Register `watcher` against a capturing context; returns recorded inputs + the context. */
export async function collectWatcherEntries(watcher: Watcher): Promise<CollectedWatcher> {
  const recorded: RecordInput[] = [];
  const config = resolveConfig({});
  let counter = 0;

  const context: WatcherContext = {
    record: (input) => {
      recorded.push(input);
    },
    // Runs the REAL capture (family hash + 4xx skip), so a watcher spec that
    // asserts on the collected entries sees exactly what production would
    // record — including a 4xx HttpException producing nothing at all.
    recordException: (error, details) => {
      captureException((input) => recorded.push(input), error, undefined, details);
    },
    runInBatch: (_origin, fn) => fn(),
    beginBatch: (): BatchHandle => ({ id: `batch-${counter++}`, end: () => {} }),
    config,
    moduleRef: {
      get: () => {
        throw new Error('moduleRef.get is not available in collectWatcherEntries');
      },
    } as unknown as WatcherContext['moduleRef'],
  };

  await watcher.register(context);
  return { recorded, context };
}
