import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20261026090000_pending_action_drop_legacy_columns';

integration('pending action legacy column drop migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'pa_drop_legacy_mig', MIGRATION);
    const db = scratch.db;
    await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u1', 'drop1@test.dev', 'x', now()), ('u2', 'drop2@test.dev', 'x', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "PendingAction" ("id", "projectId", "tool", "input", "preview", "status", "requestedById", "decidedById", "decidedAt", "expiresAt", "actorType", "actorId", "approverType", "approverId") VALUES
      ('decided', 'p1', 'koda_add_comment', '{}', 'preview', 'EXECUTED', 'u1', 'u2', now(), now(), 'user', 'u1', 'user', 'u2'),
      ('unmirrored', 'p1', 'koda_add_comment', '{}', 'preview', 'REJECTED', 'u1', 'u2', now(), now(), 'user', 'u1', NULL, NULL),
      ('pending', 'p1', 'koda_add_comment', '{}', 'preview', 'PENDING', 'u1', NULL, NULL, now(), 'user', 'u1', NULL, NULL)`);
    await applyMigration(db, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  async function action(id: string) {
    const rows = await scratch.db.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "PendingAction" WHERE "id" = $1', id);
    return rows[0];
  }

  it('drops requestedById and decidedById from PendingAction', async () => {
    const columns = await scratch.db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'PendingAction' AND column_name IN ('requestedById', 'decidedById')`,
    );
    expect(columns).toEqual([]);
  });

  it('keeps the actor and approver of an action whose approver was already recorded', async () => {
    expect(await action('decided')).toMatchObject({ actorType: 'user', actorId: 'u1', approverType: 'user', approverId: 'u2' });
  });

  it('copies a decider with no recorded approver into the approver before the drop', async () => {
    expect(await action('unmirrored')).toMatchObject({ actorType: 'user', actorId: 'u1', approverType: 'user', approverId: 'u2' });
  });

  it('leaves an undecided action without an approver', async () => {
    expect(await action('pending')).toMatchObject({ actorType: 'user', actorId: 'u1', approverType: null, approverId: null });
  });
});
