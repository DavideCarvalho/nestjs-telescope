import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { type ContainerHandle, startContainer } from './docker-container.js';

const USER = 'telescope';
const PASSWORD = 'telescope-secret';

export interface MinioHandle {
  readonly client: S3Client;
  readonly describedAs: string;
  /** Creates a fresh bucket and returns its name. */
  bucket(): Promise<string>;
  stop(): Promise<void>;
}

let buckets = 0;

/**
 * An S3-compatible server: `S3_TEST_ENDPOINT` (with `S3_TEST_ACCESS_KEY`/`S3_TEST_SECRET_KEY`)
 * when set, else a throwaway MinIO container. Docker Hub no longer serves `minio/minio`, so the
 * default image is MinIO's own registry; `MINIO_IMAGE` overrides it.
 */
export async function startMinio(): Promise<MinioHandle | null> {
  const external = process.env.S3_TEST_ENDPOINT;
  const handle: ContainerHandle | null = await startContainer(
    {
      image: process.env.MINIO_IMAGE ?? 'quay.io/minio/minio:RELEASE.2025-03-12T18-04-18Z',
      port: 9000,
      env: { MINIO_ROOT_USER: USER, MINIO_ROOT_PASSWORD: PASSWORD },
      command: ['server', '/data'],
      ready: async (baseUrl) => (await fetch(`${baseUrl}/minio/health/live`)).ok,
    },
    external,
  );
  if (handle === null) return null;
  const client = new S3Client({
    endpoint: handle.baseUrl,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: external ? (process.env.S3_TEST_ACCESS_KEY ?? '') : USER,
      secretAccessKey: external ? (process.env.S3_TEST_SECRET_KEY ?? '') : PASSWORD,
    },
  });
  return {
    client,
    describedAs: handle.describedAs,
    async bucket() {
      buckets += 1;
      const name = `telescope-test-${Date.now()}-${buckets}`;
      await client.send(new CreateBucketCommand({ Bucket: name }));
      return name;
    },
    async stop() {
      client.destroy();
      await handle.stop();
    },
  };
}
