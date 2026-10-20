// A throwaway server for the integration suites, in this order of preference:
//   1. a URL the environment already provides (a CI service, a local compose);
//   2. a container started through the Docker CLI;
//   3. nothing — the suite skips, LOUDLY, rather than asserting against a server that isn't there.
//
// The Docker CLI rather than testcontainers for the reason given in
// packages/bullmq/test/redis-container.ts: testcontainers pulls a Node runtime newer than the
// `engines.node` this repo supports.
//
// Lives under `test/` (excluded from the package build) so it never ships.
import { execFileSync } from 'node:child_process';

export interface ContainerSpec {
  image: string;
  /** The port inside the container to publish on 127.0.0.1. */
  port: number;
  env?: Record<string, string>;
  /** `-v` mounts, as `host:container[:ro]`. */
  volumes?: string[];
  /** Arguments after the image (the container's command). */
  command?: string[];
  /** Resolves true once the server at `baseUrl` answers. Polled for up to `readyTimeoutMs`. */
  ready: (baseUrl: string) => Promise<boolean>;
  readyTimeoutMs?: number;
}

export interface ContainerHandle {
  readonly baseUrl: string;
  readonly describedAs: string;
  stop(): Promise<void>;
}

function docker(args: string[], timeoutMs = 300_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, stdio: 'pipe' });
}

function mappedPort(containerId: string, port: number): number {
  const mapping =
    docker(['port', containerId, `${port}/tcp`], 15_000)
      .trim()
      .split('\n')[0] ?? '';
  const host = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
  if (!Number.isInteger(host) || host <= 0) {
    throw new Error(`could not read the mapped port from "${mapping}"`);
  }
  return host;
}

/** Resolve a server: `envUrl` when set, else a container, else null (suite skips). */
export async function startContainer(
  spec: ContainerSpec,
  envUrl: string | undefined,
): Promise<ContainerHandle | null> {
  if (envUrl) return { baseUrl: envUrl, describedAs: envUrl, stop: async () => {} };

  let containerId: string;
  try {
    docker(['version', '--format', '{{.Server.Version}}'], 15_000);
    const env = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const volumes = (spec.volumes ?? []).flatMap((volume) => ['-v', volume]);
    containerId = docker([
      'run',
      '-d',
      '--rm',
      '-p',
      `127.0.0.1::${spec.port}`,
      ...env,
      ...volumes,
      spec.image,
      ...(spec.command ?? []),
    ]).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[docker-container] Could not start ${spec.image} (${message.split('\n')[0]}); the suite will be SKIPPED.`,
    );
    return null;
  }

  const stop = async (): Promise<void> => {
    try {
      docker(['rm', '-f', containerId], 30_000);
    } catch {
      // The container is `--rm`; failing to remove it must not fail a suite.
    }
  };

  try {
    const baseUrl = `http://127.0.0.1:${mappedPort(containerId, spec.port)}`;
    const deadline = Date.now() + (spec.readyTimeoutMs ?? 60_000);
    // Each probe gets its own bound: a port that accepts the connection but never answers would
    // otherwise hold one `ready()` call open forever, and the deadline is only checked between calls.
    const probe = () =>
      Promise.race([
        spec.ready(baseUrl),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000).unref()),
      ]).catch(() => false);
    while (!(await probe())) {
      if (Date.now() > deadline) throw new Error(`${spec.image} did not become ready`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { baseUrl, describedAs: `docker ${spec.image} (${baseUrl})`, stop };
  } catch (error) {
    await stop();
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[docker-container] Started ${spec.image} but could not reach it (${message}); the suite will be SKIPPED.`,
    );
    return null;
  }
}
