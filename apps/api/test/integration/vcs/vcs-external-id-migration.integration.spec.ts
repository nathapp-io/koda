/**
 * Track 3 Slice 4 (M11): the backfill rewrites bare issue numbers to
 * owner/repo#N using the project's VCS connection.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-external-id-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TARGET = '20260929090000_vcs_external_id_repo_qualified';

describeIntegration('externalVcsId repo-qualify migration (M11)', () => {
  jest.setTimeout(60000);
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'vcs_external_id_migration', TARGET);
    const { db } = scratch;
    await db.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES
        ('p1', 'Linked', 'linked', 'LNK', CURRENT_TIMESTAMP),
        ('p2', 'Bare', 'bare', 'BAR', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "VcsConnection" ("id", "projectId", "provider", "repoOwner", "repoName", "encryptedToken", "updatedAt")
      VALUES ('c1', 'p1', 'github', 'acme', 'widgets', 'enc', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Ticket" ("id", "projectId", "number", "type", "title", "externalVcsId", "updatedAt") VALUES
        ('t-bare',      'p1', 1, 'TASK', 'a', '12',              CURRENT_TIMESTAMP),
        ('t-qualified', 'p1', 2, 'TASK', 'b', 'acme/widgets#3',  CURRENT_TIMESTAMP),
        ('t-null',      'p1', 3, 'TASK', 'c', NULL,              CURRENT_TIMESTAMP),
        ('t-odd',       'p1', 4, 'TASK', 'd', 'not-a-number',    CURRENT_TIMESTAMP),
        ('t-orphan',    'p2', 1, 'TASK', 'e', '7',               CURRENT_TIMESTAMP)
    `);
    await applyMigration(db, TARGET);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it.each([
    ['t-bare', 'acme/widgets#12'],
    ['t-qualified', 'acme/widgets#3'],
    ['t-null', null],
    ['t-odd', 'not-a-number'],
    ['t-orphan', '7'],
  ])('%s ends as %s', async (id, expected) => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ externalVcsId: string | null }>>(
      `SELECT "externalVcsId" FROM "Ticket" WHERE "id" = '${id}'`,
    );
    expect(rows[0].externalVcsId).toBe(expected);
  });
});
