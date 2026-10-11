/**
 * Skill catalog migration (PG) — 20261012090000_skill_catalog creates the three tables
 * and the (owner, repo, ref, path) unique index on a scratch schema.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/skills/skill-catalog-migration.integration.spec.ts
 */
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const MIGRATION = '20261012090000_skill_catalog';

describeIntegration('skill catalog migration (PG)', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'skill_catalog_migration', MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
  });
  afterAll(async () => {
    await scratch?.drop();
  });

  it('AC-15: creates the SkillSource, Skill and ProjectSkill tables', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'skill_catalog_migration'
         AND tablename IN ('SkillSource', 'Skill', 'ProjectSkill') ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(['ProjectSkill', 'Skill', 'SkillSource']);
  });

  it('AC-15: rejects a second SkillSource with the same owner, repo, ref and path', async () => {
    const insert = `INSERT INTO "SkillSource" ("id", "gitUrl", "owner", "repo", "ref", "path", "status", "createdById", "updatedAt")
      VALUES ($1, 'https://github.com/acme/skills', 'acme', 'skills', 'main', '', 'OK', 'u1', CURRENT_TIMESTAMP)`;
    await scratch.db.$executeRawUnsafe(insert, 's1');
    await expect(scratch.db.$executeRawUnsafe(insert, 's2')).rejects.toThrow(/unique|duplicate/i);
  });
});
