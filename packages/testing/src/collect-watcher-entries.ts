import {
  type BatchHandle,
  type RecordInput,
  type Watcher,
  type WatcherContext,
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
