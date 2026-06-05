// integration/memory-soak/src/run-cell.ts
//
// Runs ONE soak cell end-to-end and returns its slope:
//  1. (optional) start the OTel NodeSDK with a dead OTLP exporter
//  2. boot the Nest app, register global telescopeRequestCapture, listen
//  3. drive sustained keep-alive HTTP load
//  4. warm up, then every sampleIntervalMs: global.gc() + record heapUsed
//  5. compute the post-warmup OLS slope (bytes/min)
//  6. (optional) write a heap snapshot for retainer analysis
//  7. tear everything down

import { TelescopeService, telescopeRequestCapture } from '@dudousxd/nestjs-telescope';
import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import type { RunOptions, SoakConfig } from './config.js';
import { writeSnapshot } from './heap-retainers.js';
import { startLoad } from './load-driver.js';
import { startOtel } from './otel.js';
import { type HeapSample, type SlopeResult, computeSlope } from './regression.js';

export interface CellResult {
  config: SoakConfig;
  slope: SlopeResult;
  samples: HeapSample[];
  requestsCompleted: number;
  otelActive: boolean;
  pass: boolean;
}

function requireGc(): () => void {
  const gc = globalThis.gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc is unavailable — run node with --expose-gc');
  }
  return () => gc();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Resolve `promise`, but give up after `ms` so a hung teardown step never
 * stalls the whole run. The dead OTLP exporter's BatchSpanProcessor flush on
 * shutdown can block indefinitely retrying ECONNREFUSED — bound it.
 */
async function withTimeout(promise: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      process.stderr.write(`  teardown step "${label}" timed out after ${ms}ms — continuing\n`);
      resolve();
    }, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([promise.then(() => undefined), guard]);
  } catch {
    // A rejecting teardown step must not abort the run.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bootApp(config: SoakConfig): Promise<{ app: INestApplication; baseUrl: string }> {
  const app = await NestFactory.create(AppModule.forSoak(config), {
    logger: ['error', 'warn'],
  });
  // The incident wiring: global capture + registerRequestMiddleware:false.
  app.use(telescopeRequestCapture(app.get(TelescopeService)));
  await app.listen(0);
  const url = await app.getUrl();
  // getUrl() can report ::1/0.0.0.0; normalize to a dialable loopback.
  const baseUrl = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  return { app, baseUrl };
}

export async function runCell(
  config: SoakConfig,
  options: RunOptions,
  logger: Logger,
): Promise<CellResult> {
  const gc = requireGc();
  const otel = config.otel ? await startOtel() : { active: false, shutdown: async () => {} };
  const { app, baseUrl } = await bootApp(config);
  const load = startLoad(baseUrl, options.concurrency);

  logger.log(
    `cell "${config.label}" booted at ${baseUrl} ` +
      `(storage=${config.storage}, otel=${otel.active}, warmup=${options.warmupMs}ms, ` +
      `duration=${options.durationMs}ms, concurrency=${options.concurrency})`,
  );

  // Warm up: let JIT, pools, and the first prune cycle settle before sampling.
  await sleep(options.warmupMs);

  const samples: HeapSample[] = [];
  const startedAt = Date.now();
  let nextSampleAt = 0;
  while (Date.now() - startedAt < options.durationMs) {
    await sleep(Math.min(options.sampleIntervalMs, 1_000));
    const elapsed = Date.now() - startedAt;
    if (elapsed >= nextSampleAt) {
      gc();
      const heapUsedBytes = process.memoryUsage().heapUsed;
      samples.push({ elapsedMs: elapsed, heapUsedBytes });
      logger.log(
        `  [${config.label}] t=${(elapsed / 1000).toFixed(0)}s ` +
          `heapUsed=${(heapUsedBytes / (1024 * 1024)).toFixed(1)}MB ` +
          `reqs=${load.completed()}`,
      );
      nextSampleAt = elapsed + options.sampleIntervalMs;
    }
  }

  if (options.heapSnapshotPath !== undefined) {
    gc();
    writeSnapshot(options.heapSnapshotPath);
    logger.log(`  [${config.label}] heap snapshot written: ${options.heapSnapshotPath}`);
  }

  const slope = computeSlope(samples);
  const requestsCompleted = load.completed();

  await withTimeout(load.stop(), 15_000, 'load.stop');
  await withTimeout(app.close(), 15_000, 'app.close');
  await withTimeout(otel.shutdown(), 5_000, 'otel.shutdown');

  return {
    config,
    slope,
    samples,
    requestsCompleted,
    otelActive: otel.active,
    pass: slope.bytesPerMin <= options.thresholdBytesPerMin,
  };
}
