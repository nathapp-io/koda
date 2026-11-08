import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, migrationStatements, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261130100000_developer_flow_answer_key';
const KEY = 'fleet.flow.answer';
const NON_DEVELOPER = ['project.read'];

integration('developer flow answer permission migration', () => {
  let scratch: ScratchSchema;
  let backfill: string;

  const setRole = (key: string, permissions: string[]) =>
    scratch.db.$executeRawUnsafe('UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = $2', JSON.stringify(permissions), key);
  const permissionsOf = async (key: string): Promise<unknown> => {
    const rows = await scratch.db.$queryRawUnsafe<{ permissions: unknown }[]>('SELECT "permissions" FROM "Role" WHERE "key" = $1', key);
    return rows[0]?.permissions;
  };

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'developer_flow_answer_mig', MIGRATION);
    backfill = migrationStatements(MIGRATION).find((statement) => statement.startsWith('UPDATE "Role"')) ?? '';
    if (!backfill) throw new Error('Developer flow answer update is missing from migration');
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES
       ('developer', 'developer', 'Developer', 'PROJECT', '[]'::jsonb, now()),
       ('other', 'reviewer', 'Reviewer', 'PROJECT', '[]'::jsonb, now())`,
    );
  }, 120_000);
  beforeEach(async () => {
    await setRole('developer', ['thread.create']);
    await setRole('reviewer', NON_DEVELOPER);
  });
  afterAll(async () => { await scratch?.drop(); });

  it('AC-4: appends the answer key to a developer role without it', async () => {
    await applyMigration(scratch.db, MIGRATION);
    expect(await permissionsOf('developer')).toEqual(['thread.create', KEY]);
  });

  it('AC-5: preserves an explicit denial', async () => {
    await setRole('developer', ['thread.create', `!${KEY}`]);
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('developer')).toEqual(['thread.create', `!${KEY}`]);
  });

  it('AC-6: is idempotent', async () => {
    await scratch.db.$executeRawUnsafe(backfill);
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('developer')).toEqual(['thread.create', KEY]);
    expect((await permissionsOf('developer') as string[]).filter((permission) => permission === KEY)).toHaveLength(1);
  });

  it('AC-7: leaves non-developer roles unchanged', async () => {
    await scratch.db.$executeRawUnsafe(backfill);
    expect(await permissionsOf('reviewer')).toEqual(NON_DEVELOPER);
  });
});
