import { InMemoryStorageProvider } from '@dudousxd/nestjs-telescope';
import { describeStorageProvider } from '@dudousxd/nestjs-telescope-testing/conformance';
import { afterAll } from 'vitest';
import { startMinio } from '../test/minio-container.js';
import { archiveOlderHalf } from '../test/tiers.js';
import { type ColdEngineOption, parquetColdStore } from './parquet-cold-store.js';
import { tieredStorage } from './tiered-storage.js';

const minio = await startMinio();
const bucket = minio ? await minio.bucket() : '';
let prefixes = 0;

afterAll(async () => {
  await minio?.stop();
});

function onS3(engine: ColdEngineOption = 'hyparquet') {
  return () => {
    prefixes += 1;
    return tieredStorage({
      hot: new InMemoryStorageProvider(),
      cold: parquetColdStore({
        location: { s3: { bucket, prefix: `conformance/${prefixes}`, client: minio!.client } },
        engine,
      }),
    });
  };
}

const skip = minio === null ? { skip: 'no S3_TEST_ENDPOINT and no Docker daemon' } : {};

describeStorageProvider(
  `tieredStorage (hot: in-memory, cold: ${minio?.describedAs ?? 'MinIO'}, older half archived)`,
  onS3(),
  { afterSeed: archiveOlderHalf, ...skip },
);

describeStorageProvider(
  `tieredStorage (hot: in-memory, cold: ${minio?.describedAs ?? 'MinIO'} via DuckDB, older half archived)`,
  onS3({ duckdb: { threads: 1 } }),
  { afterSeed: archiveOlderHalf, ...skip },
);
