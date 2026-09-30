import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { assertSafeTestDatabaseUrl } from '../../../../api/test/helpers/test-database-url';

export const API_DIR = resolve(import.meta.dir, '../../../../api');
const DATABASE_NAME = 'koda_runner_test';

/**
 * D38: a database of our own on the compose test server (`docker-compose.test.yml`, port 5433), so this suite never clobbers
 * the API integration database. `DATABASE_URL` is deliberately ignored: importing `@prisma/client` loads `apps/api/.env`
 * into `process.env`, so a developer's dev URL (or a stale SQLite one) would arrive here. Override with
 * `KODA_RUNNER_TEST_DATABASE_URL`; `assertSafeTestDatabaseUrl` still requires a local `*_test` database.
 */
export function runnerTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env['KODA_RUNNER_TEST_DATABASE_URL'] ?? `postgresql://koda:koda@localhost:5433/${DATABASE_NAME}`;
}

/**
 * `migrate reset` creates the database when it is missing and applies every migration (the web e2e precedent).
 * The consent variable exists because Prisma refuses destructive commands from AI agents without it; it is safe here
 * because the URL is checked to be a local `*_test` database first.
 */
export async function prepareDatabase(databaseUrl: string): Promise<void> {
  assertSafeTestDatabaseUrl(databaseUrl);
  const proc = Bun.spawn(['bunx', 'prisma', 'migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], {
    cwd: API_DIR, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: 'yes' },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`prisma migrate reset failed (${code}):\n${out}\n${err}`);
}

export async function assertPartialIndex(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE indexname = 'FleetJob_active_repo_feature_key'`;
  if (rows.length !== 1 || !/WHERE/i.test(rows[0].indexdef)) {
    throw new Error('the partial unique index FleetJob_active_repo_feature_key is missing: migrate reset did not apply the fleet migrations');
  }
}
