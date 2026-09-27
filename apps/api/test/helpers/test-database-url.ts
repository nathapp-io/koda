/**
 * Guard for jest globalSetup, which runs `prisma db push --force-reset`.
 *
 * Only a Postgres database on the local machine whose name ends in `_test`
 * (e.g. the `docker-compose.test.yml` one at localhost:5433/koda_test) may be
 * reset. Anything else, such as a dev database or a stale SQLite URL inherited
 * from a parent process, is refused before Prisma touches it.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const POSTGRES_PROTOCOLS = new Set(['postgresql:', 'postgres:']);
const TEST_DATABASE_NAME = /^[A-Za-z0-9_]+_test$/;

function describeTarget(url: URL): string {
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${port}${url.pathname}`;
}

export function assertSafeTestDatabaseUrl(databaseUrl: string): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('KODA_DB_TESTS=1: refusing to reset a DATABASE_URL that is not a valid URL');
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const safe =
    POSTGRES_PROTOCOLS.has(url.protocol) && LOCAL_HOSTS.has(url.hostname) && TEST_DATABASE_NAME.test(databaseName);

  if (!safe) {
    throw new Error(
      `KODA_DB_TESTS=1: refusing to reset ${describeTarget(url)}; ` +
        'DATABASE_URL must be a local Postgres database named *_test (see apps/api/.env.test)',
    );
  }
}
