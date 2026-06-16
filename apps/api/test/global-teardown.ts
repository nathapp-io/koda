/**
 * Jest globalTeardown — runs ONCE after the whole test run, on success OR
 * failure.
 *
 * Deletes the ephemeral SQLite test database created by globalSetup
 * (test/global-setup.ts) so no stale DB file is left behind between runs. The
 * schema-create cost is paid fresh by the next run's globalSetup, which is the
 * correct trade now that the file is treated as a disposable run artifact
 * rather than a long-lived fixture.
 *
 * Gated on DATABASE_URL exactly like globalSetup and the test files: when no
 * test database is configured the DB-backed suites skip, so there is nothing to
 * tear down here either.
 *
 * SQLite writes sidecar files (-wal, -shm, -journal) depending on the journal
 * mode in effect, so we remove those alongside the main DB file.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
import { rmSync } from 'fs';

export default async function globalTeardown(): Promise<void> {
  // Resolve DATABASE_URL the same way globalSetup/test-setup do, regardless of
  // how Jest was invoked.
  config({ path: resolve(__dirname, '../.env.test'), quiet: true });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !databaseUrl.startsWith('file:')) return;

  // Strip the `file:` scheme; remaining value is a filesystem path that SQLite
  // resolves relative to the process working directory.
  const dbPath = resolve(process.cwd(), databaseUrl.slice('file:'.length));

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
