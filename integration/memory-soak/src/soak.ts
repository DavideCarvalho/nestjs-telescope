// integration/memory-soak/src/soak.ts
//
// Runnable soak entrypoint. Runs the selected bisection cells sequentially (each
// in its own freshly-booted app) and prints a slope table. Exit code is nonzero
// when any selected cell exceeds the leak threshold, so it doubles as a guard.
//
//   node --expose-gc dist/soak.js
//   SOAK_CELLS="full,no fat user" SOAK_DURATION_MS=120000 node --expose-gc dist/soak.js
//
// Run a single cell with a heap snapshot for retainer analysis:
//   SOAK_CELLS=full SOAK_HEAPSNAPSHOT=/tmp/full.heapsnapshot node --expose-gc dist/soak.js

import { Logger } from '@nestjs/common';
import { type SoakConfig, buildMatrix, resolveRunOptions, selectCells } from './config.js';
import { formatBytes, formatSlope } from './regression.js';
import { type CellResult, runCell } from './run-cell.js';

function printTable(results: CellResult[], thresholdBytesPerMin: number): void {
  const threshold = formatSlope(thresholdBytesPerMin);
  process.stdout.write('\n================ SOAK SLOPE TABLE ================\n');
  process.stdout.write(`threshold: <= ${threshold}\n\n`);
  const header = ['cell', 'slope', 'first', 'last', 'Δ', 'reqs', 'verdict'];
  process.stdout.write(`${header.join(' | ')}\n`);
  for (const result of results) {
    const row = [
      result.config.label.padEnd(20),
      formatSlope(result.slope.bytesPerMin).padStart(12),
      formatBytes(result.slope.firstBytes).padStart(9),
      formatBytes(result.slope.lastBytes).padStart(9),
      formatBytes(result.slope.deltaBytes).padStart(9),
      String(result.requestsCompleted).padStart(8),
      result.pass ? 'PASS' : 'FAIL',
    ];
    process.stdout.write(`${row.join(' | ')}\n`);
  }
  process.stdout.write('=================================================\n');
}

async function main(): Promise<number> {
  const logger = new Logger('soak');
  const heapSnapshotPath = process.env.SOAK_HEAPSNAPSHOT;
  const baseOptions = resolveRunOptions(heapSnapshotPath !== undefined ? { heapSnapshotPath } : {});
  const cells: SoakConfig[] = selectCells(buildMatrix());

  logger.log(`running ${cells.length} cell(s): ${cells.map((cell) => cell.label).join(', ')}`);

  const results: CellResult[] = [];
  for (const cell of cells) {
    const result = await runCell(cell, baseOptions, logger);
    results.push(result);
    logger.log(
      `cell "${cell.label}" done: slope=${formatSlope(result.slope.bytesPerMin)} ` +
        `(${result.pass ? 'PASS' : 'FAIL'})`,
    );
  }

  printTable(results, baseOptions.thresholdBytesPerMin);

  const failures = results.filter((result) => !result.pass);
  return failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    // The OTel NodeSDK can leave a timer/keep-alive socket pinned to the dead
    // OTLP endpoint that keeps the loop alive past our bounded shutdown. This is
    // a one-shot CLI, so exit explicitly rather than hang waiting for the loop
    // to drain.
    process.exit(code);
  })
  .catch((error: unknown) => {
    process.stderr.write(`soak failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
