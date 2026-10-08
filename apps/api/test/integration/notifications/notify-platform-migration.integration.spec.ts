/**
 * Fleet S4b §2.1: the S4a preference table is renamed with rows kept and channels lowercased; package tables exist.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/notifications/notify-platform-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20261010090000_notify_platform';

describeIntegration('notify platform migration (S4b §2.1)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'notify_platform_migration', TARGET);
    await scratch.db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u1', 'u1@k.t', 'x', CURRENT_TIMESTAMP)`);
    await scratch.db.$executeRawUnsafe(`INSERT INTO "NotificationPreference" ("userId", "category", "channel", "enabled") VALUES ('u1', 'ASSIGNED', 'IN_APP', false)`);
    await applyMigration(scratch.db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('keeps S4a rows under the new table with a lowercase channel', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ userId: string; category: string; channel: string; enabled: boolean }>>(
      `SELECT "userId", "category", "channel", "enabled" FROM "NotificationCategoryPreference"`);
    expect(rows).toEqual([{ userId: 'u1', category: 'ASSIGNED', channel: 'in_app', enabled: false }]);
  });

  it('creates the package tables', async () => {
    const tables = await scratch.db.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename IN ('notification_preferences', 'delivery_logs', 'notification_templates') ORDER BY tablename`);
    expect(tables.map((t) => t.tablename)).toEqual(['delivery_logs', 'notification_preferences', 'notification_templates']);
  });

  it('cascades the renamed table from User', async () => {
    await scratch.db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = 'u1'`);
    const [{ n }] = await scratch.db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "NotificationCategoryPreference"`);
    expect(Number(n)).toBe(0);
  });
});
