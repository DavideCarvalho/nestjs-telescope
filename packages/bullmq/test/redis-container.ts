// packages/bullmq/test/redis-container.ts
//
// A real Redis for the integration suites, in this order of preference:
//   1. `REDIS_URL` if the environment already provides one (a CI service, a
//      local docker-compose, a colleague's laptop);
//   2. a throwaway `redis:7-alpine` container, started through the Docker CLI;
//   3. nothing — the suite skips, LOUDLY, rather than quietly asserting against
//      a Redis that isn't there.
//
// The Docker CLI rather than testcontainers on purpose: testcontainers v12
// pulls `undici@8`, which needs a newer Node than the `engines.node: >=20` this
// repo supports and CI runs on — the suite would fail to even load there. A
// `docker run` is ~40 lines and has no runtime the host has to satisfy.
//
// Lives under `test/` (excluded from the package build) so it never ships, and
// is a plain module rather than a `*.spec.ts` so Vitest does not collect it.
//
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

const IMAGE = 'redis:7-alpine';

export interface RedisHandle {
  /** ioredis connection options — NOT `{ url }`, which ioredis ignores. */
  readonly connection: { host: string; port: number };
  readonly describedAs: string;
  stop(): Promise<void>;
}

function docker(args: string[], timeoutMs = 120_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe' });
}

/** Split a redis:// URL into the fields ioredis actually reads. */
function fromUrl(raw: string): RedisHandle {
  const url = new URL(raw);
  const port = Number(url.port) || 6379;
  return {
    connection: { host: url.hostname, port },
    describedAs: `REDIS_URL (${url.hostname}:${port})`,
    stop: async () => {},
  };
}

/** Resolve once the port accepts a TCP connection, or throw after ~30s. */
async function waitForPort(host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      const fail = (): void => {
        socket.destroy();
        resolve(false);
      };
      socket.once('error', fail);
      socket.once('timeout', fail);
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`redis did not start listening on ${host}:${port}`);
}

/** The host port Docker mapped to the container's 6379. */
function mappedPort(containerId: string): number {
  const mapping = docker(['port', containerId, '6379/tcp'], 15_000).trim().split('\n')[0] ?? '';
  const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`could not read the mapped port from "${mapping}"`);
  }
  return port;
}

async function fromDocker(): Promise<RedisHandle | null> {
  let containerId: string;
  try {
    docker(['version', '--format', '{{.Server.Version}}'], 15_000);
    containerId = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', IMAGE]).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[redis-container] Docker is unavailable (${message.split('\n')[0]}); the real-Redis suite will be SKIPPED. Set REDIS_URL or start a Docker daemon to run it.`,
    );
    return null;
  }

  const stop = async (): Promise<void> => {
    try {
      docker(['rm', '-f', containerId], 30_000);
    } catch {
      // The container is `--rm`; a failure to remove it must not fail a suite.
    }
  };

  try {
    const port = mappedPort(containerId);
    await waitForPort('127.0.0.1', port);
    return {
      connection: { host: '127.0.0.1', port },
      describedAs: `docker ${IMAGE} (127.0.0.1:${port})`,
      stop,
    };
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[redis-container] Started ${IMAGE} but could not reach it (${message}); the real-Redis suite will be SKIPPED.`,
    );
    return null;
  }
}

/** Resolve a usable Redis, or null when the environment cannot provide one. */
export async function startRedis(): Promise<RedisHandle | null> {
  const url = process.env.REDIS_URL;
  if (url) return fromUrl(url);
  return fromDocker();
}
