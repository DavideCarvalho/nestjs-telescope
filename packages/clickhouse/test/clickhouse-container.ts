import { fileURLToPath } from 'node:url';
import { type ContainerHandle, startContainer } from './docker-container.js';

export const CLICKHOUSE_USER = 'telescope';
export const CLICKHOUSE_PASSWORD = 'telescope';

const KEEPER_CONFIG = fileURLToPath(new URL('./keeper.xml', import.meta.url));

/**
 * A ClickHouse to test against: `CLICKHOUSE_URL` when set, else a throwaway container. With
 * `keeper` (the default) the container runs an embedded ClickHouse Keeper, so KeeperMap tables —
 * and with them `markFamilySeen` — work. `keeper: false` never uses `CLICKHOUSE_URL`: it exists
 * to prove the provider's behaviour on a server without Keeper.
 */
export function startClickHouse(
  options: { keeper?: boolean } = {},
): Promise<ContainerHandle | null> {
  const keeper = options.keeper ?? true;
  return startContainer(
    {
      image: process.env.CLICKHOUSE_IMAGE ?? 'clickhouse/clickhouse-server:24.8-alpine',
      port: 8123,
      env: { CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DB: 'telescope' },
      ...(keeper
        ? { volumes: [`${KEEPER_CONFIG}:/etc/clickhouse-server/config.d/keeper.xml:ro`] }
        : {}),
      ready: async (baseUrl) => (await fetch(`${baseUrl}/ping`)).ok,
      readyTimeoutMs: 120_000,
    },
    keeper ? process.env.CLICKHOUSE_URL : undefined,
  );
}
