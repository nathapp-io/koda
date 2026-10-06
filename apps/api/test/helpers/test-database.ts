/**
 * Which Postgres a DB-mode jest run (`KODA_DB_TESTS=1`) uses, in order:
 *
 * 1. `KODA_TEST_DATABASE_URL`, when set (CI, or a database the developer manages).
 * 2. The compose test database from `.env.test` (`bun run test:db:up`, localhost:5433), when it
 *    answers. nax's agent shell is sandboxed without Docker access but can reach this port, so
 *    agent-side runs keep working while it is up. Skipped with `KODA_TEST_DB_CONTAINER=1`, so a
 *    second checkout (worktree, clone) never resets a database another checkout is using.
 * 3. A throwaway Postgres 16 started with Testcontainers, stopped by globalTeardown.
 *
 * The caller still passes the result through `assertSafeTestDatabaseUrl` before resetting it.
 */
import { createConnection } from 'net';

export type TestDatabaseSource = 'explicit' | 'compose' | 'testcontainers';

export interface TestDatabase {
  readonly databaseUrl: string;
  readonly source: TestDatabaseSource;
  stop(): Promise<void>;
}

export interface TestDatabaseDeps {
  probe(databaseUrl: string): Promise<boolean>;
  start(): Promise<TestDatabase>;
}

const POSTGRES_IMAGE = 'postgres:16';
const TEST_DATABASE = 'koda_test';
const PROBE_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 120_000;

const noStop = async (): Promise<void> => undefined;

/** True when something accepts a TCP connection on the URL's host and port. */
export function probeDatabase(databaseUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return Promise.resolve(false);
  }
  const port = url.port ? Number(url.port) : 5432;
  return new Promise((resolve) => {
    const socket = createConnection({ host: url.hostname, port });
    const done = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function startTestContainer(): Promise<TestDatabase> {
  // Loaded lazily: unit runs share this globalSetup and must not need the Docker client.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEST_DATABASE)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
  return {
    databaseUrl: container.getConnectionUri(),
    source: 'testcontainers',
    stop: async () => {
      await container.stop();
    },
  };
}

const DEFAULT_DEPS: TestDatabaseDeps = { probe: probeDatabase, start: startTestContainer };

export async function resolveTestDatabase(
  env: NodeJS.ProcessEnv,
  composeUrl: string | undefined,
  deps: TestDatabaseDeps = DEFAULT_DEPS,
): Promise<TestDatabase> {
  const explicitUrl = env['KODA_TEST_DATABASE_URL'];
  if (explicitUrl) {
    return { databaseUrl: explicitUrl, source: 'explicit', stop: noStop };
  }
  const useCompose = env['KODA_TEST_DB_CONTAINER'] !== '1';
  if (useCompose && composeUrl && (await deps.probe(composeUrl))) {
    return { databaseUrl: composeUrl, source: 'compose', stop: noStop };
  }
  try {
    return await deps.start();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      'KODA_DB_TESTS=1: no test Postgres. The compose database is down and Testcontainers could not ' +
        `start one (${reason}). Run \`bun run test:db:up\` in apps/api, start Docker, or set ` +
        'KODA_TEST_DATABASE_URL.',
    );
  }
}

const TEST_DATABASE_GLOBAL = '__KODA_TEST_DATABASE__';

/** globalSetup and globalTeardown run in the same process: hand the database over through globalThis. */
export function rememberTestDatabase(database: TestDatabase): void {
  (globalThis as Record<string, unknown>)[TEST_DATABASE_GLOBAL] = database;
}

export function rememberedTestDatabase(): TestDatabase | undefined {
  return (globalThis as Record<string, unknown>)[TEST_DATABASE_GLOBAL] as TestDatabase | undefined;
}
