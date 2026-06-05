// integration/memory-soak/src/analyze-snapshot.ts
//
// Offline retainer analysis of a heap snapshot produced by a soak run:
//   node dist/analyze-snapshot.js /tmp/full.heapsnapshot
// Prints the top constructors by aggregate self size (the retained-type profile).

import { formatRetainers, topRetainers } from './heap-retainers.js';

function main(): void {
  const snapshotPath = process.argv[2];
  if (snapshotPath === undefined) {
    process.stderr.write('usage: analyze-snapshot <path-to.heapsnapshot> [limit]\n');
    process.exitCode = 1;
    return;
  }
  const limitArg = process.argv[3];
  const limit = limitArg !== undefined ? Number.parseInt(limitArg, 10) : 25;
  const rows = topRetainers(snapshotPath, Number.isFinite(limit) && limit > 0 ? limit : 25);
  process.stdout.write(`Top retainers by aggregate self size — ${snapshotPath}\n`);
  process.stdout.write(`${formatRetainers(rows)}\n`);
}

main();
