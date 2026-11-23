// packages/drizzle/test/postgres.ts
//
// One PostgreSQL container per spec file (testcontainers), skipped with TELESCOPE_SKIP_DOCKER=1 or
// when no Docker daemon answers, saying why, rather than failing the file at import.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

export interface TestPostgres {
  container: StartedPostgreSqlContainer | null;
  /** Why the database-backed suites are skipped, or `null` when it is up. */
  skipReason: string | null;
  url: string;
}

export async function startPostgres(image = 'postgres:16-alpine'): Promise<TestPostgres> {
  if (process.env.TELESCOPE_SKIP_DOCKER === '1') {
    return { container: null, skipReason: 'TELESCOPE_SKIP_DOCKER=1', url: '' };
  }
  try {
    const container = await new PostgreSqlContainer(image).start();
    return { container, skipReason: null, url: container.getConnectionUri() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { container: null, skipReason: `cannot start PostgreSQL: ${reason}`, url: '' };
  }
}

/** A fresh database on the container, so a spec can prove what boot does to an empty one. */
export async function freshDatabase(url: string, name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}
