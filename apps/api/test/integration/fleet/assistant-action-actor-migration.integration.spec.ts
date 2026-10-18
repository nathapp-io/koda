import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20261025090000_assistant_action_actor';

integration('assistant actor migration', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'assistant_actor_mig', MIGRATION);
    const db = scratch.db;
    await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt") VALUES ('u1', 'actor1@test.dev', 'x', now()), ('u2', 'actor2@test.dev', 'x', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES ('p1', 'P', 'p', 'PP', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "FleetRepo" ("id", "projectId", "provider", "owner", "name", "defaultBranch", "createdById") VALUES ('r1', 'p1', 'github', 'acme', 'app', 'main', 'u1')`);
    await db.$executeRawUnsafe(`INSERT INTO "ChatThread" ("id", "projectId", "kind", "title", "createdById", "backend", "skills") VALUES ('t1', 'p1', 'PROJECT', 'T', 'u1', '{}', '[]')`);
    await db.$executeRawUnsafe(`INSERT INTO "FleetJob" ("id", "projectId", "repoId", "ref", "command", "feature", "profiles", "selectorLabels", "maxCostUsd", "requestedById", "updatedAt") VALUES ('j1', 'p1', 'r1', 'main', 'THREAD', 'actor', '{}', '{}', 5, 'u1', now())`);
    await db.$executeRawUnsafe(`INSERT INTO "PendingAction" ("id", "projectId", "threadId", "jobId", "toolCallId", "tool", "input", "preview", "requestedById", "decidedById", "expiresAt") VALUES
      ('a1', 'p1', 't1', 'j1', 'c1', 'koda_add_comment', '{}', 'preview', 'u1', 'u2', now()),
      ('a2', 'p1', 't1', 'j1', 'c2', 'koda_add_comment', '{}', 'preview', 'u1', NULL, now())`);
    await db.$executeRawUnsafe(`INSERT INTO "AssistantToolCall" ("id", "jobId", "threadId", "projectId", "toolCallId", "tool", "inputHash", "outcome", "content", "isError", "resultBytes", "durationMs") VALUES
      ('audit1', 'j1', 't1', 'p1', 'c1', 'koda_add_comment', 'hash', 'ok', 'ok', false, 2, 0),
      ('audit2', 'j1', 'deleted-thread', 'p1', 'c2', 'koda_add_comment', 'hash', 'ok', 'ok', false, 2, 0)`);
    await applyMigration(db, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  async function action(id: string) {
    const rows = await scratch.db.$queryRawUnsafe<Record<string, unknown>[]>('SELECT * FROM "PendingAction" WHERE "id" = $1', id);
    return rows[0];
  }
  it('AC-1: backfills the requesting user as actor', async () => {
    expect(await action('a1')).toMatchObject({ actorType: 'user', actorId: 'u1' });
  });
  it('AC-2: backfills thread origin and human approval', async () => {
    expect(await action('a1')).toMatchObject({ origin: 'thread', approvalMode: 'human' });
  });
  it('AC-3: backfills a recorded decider as approver', async () => {
    expect(await action('a1')).toMatchObject({ approverType: 'user', approverId: 'u2' });
  });
  it('AC-4: leaves an undecided approver null', async () => {
    expect(await action('a2')).toMatchObject({ approverType: null, approverId: null });
  });
  it.each([['AC-5', 'audit1'], ['AC-6', 'audit2']])('%s: backfills audit actor from job even without a thread', async (_ac, id) => {
    const rows = await scratch.db.$queryRawUnsafe<Record<string, unknown>[]>('SELECT "actorType", "actorId" FROM "AssistantToolCall" WHERE "id" = $1', id);
    expect(rows).toEqual([{ actorType: 'user', actorId: 'u1' }]);
  });
});
