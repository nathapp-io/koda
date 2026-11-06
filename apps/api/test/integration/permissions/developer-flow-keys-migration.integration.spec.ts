import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, migrationStatements, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

// #401: fleet_flows added the flow keys to the developer system role in code only. The seeder keeps
// unlocked system roles as they are, so an upgraded install needs this backfill.
const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261126090000_developer_flow_keys';
const FLOW_KEYS = ['fleet.flow.create', 'fleet.flow.stop', 'fleet.flow.start', 'fleet.thread.preapprove'];
const VIEWER = ['project.read'];

integration('developer flow keys permission migration', () => {
  let scratch: ScratchSchema;
  let backfill: string;

  const setRole = (key: string, permissions: string[]) =>
    scratch.db.$executeRawUnsafe('UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = $2', JSON.stringify(permissions), key);
  const permissionsOf = async (key: string): Promise<unknown> => {
    const rows = await scratch.db.$queryRawUnsafe<{ permissions: unknown }[]>('SELECT "permissions" FROM "Role" WHERE "key" = $1', key);
    return rows[0]?.permissions;
  };

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'developer_flow_keys_mig', MIGRATION);
    backfill = migrationStatements(MIGRATION).find((statement) => statement.startsWith('UPDATE "Role"')) ?? '';
    if (!backfill) throw new Error('Developer role update is missing from migration');
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES
       ('developer', 'developer', 'Developer', 'PROJECT', '[]'::jsonb, now()),
       ('viewer', 'viewer', 'Viewer', 'PROJECT', '[]'::jsonb, now())`,
    );
  }, 120_000);
  beforeEach(async () => {
    await setRole('developer', ['thread.create', '!ticket.delete']);
    await setRole('viewer', VIEWER);
  });
  afterAll(async () => { await scratch?.drop(); });

  it('appends the four flow keys to a pre-F1 developer role', async () => {
    await applyMigration(scratch.db, MIGRATION);
    expect(await permissionsOf('developer')).toEqual(['thread.create', '!ticket.delete', ...FLOW_KEYS]);
  });

  it('is idempotent', async () => {
    await scratch.db.$executeRawUnsafe(backfill);
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('developer')).toEqual(['thread.create', '!ticket.delete', ...FLOW_KEYS]);
  });

  it('adds only the keys the role is missing', async () => {
    await setRole('developer', ['thread.create', 'fleet.flow.create']);
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('developer')).toEqual(['thread.create', ...FLOW_KEYS]);
  });

  it('keeps a local denial: a key denied with ! is not granted', async () => {
    await setRole('developer', ['thread.create', '!fleet.flow.start']);
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('developer')).toEqual(['thread.create', '!fleet.flow.start', 'fleet.flow.create', 'fleet.flow.stop', 'fleet.thread.preapprove']);
  });

  it('leaves every other role untouched', async () => {
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('viewer')).toEqual(VIEWER);
  });
});
