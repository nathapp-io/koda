/**
 * Skill catalog schema (PG) — SkillSource, Skill and ProjectSkill unique indexes.
 * Run: cd apps/api && bun run test:scoped test/integration/skills/skill-catalog-schema.integration.spec.ts
 */
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('skill catalog schema (PG)', () => {
  const prisma = createTestPrismaClient();

  const source = (overrides: Partial<{ owner: string; repo: string; ref: string; path: string }> = {}) => ({
    gitUrl: 'https://github.com/acme/skills',
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: '',
    status: 'OK',
    createdById: 'u1',
    ...overrides,
  });

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('AC-13: rejects a second SkillSource with the same owner, repo, ref and path', async () => {
    await prisma.skillSource.create({ data: source() });
    await expect(prisma.skillSource.create({ data: source() })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('AC-13: allows the same owner and repo under a different ref or path', async () => {
    await expect(prisma.skillSource.create({ data: source({ ref: 'v2', path: 'skills' }) })).resolves.toMatchObject({
      ref: 'v2',
      path: 'skills',
    });
  });

  it('AC-14: rejects a Skill whose name already belongs to a Skill under another source', async () => {
    const first = await prisma.skillSource.create({ data: source({ ref: 'main-x' }) });
    const second = await prisma.skillSource.create({ data: source({ ref: 'main-y' }) });
    const skill = { description: 'Review a spec', dir: 'spec-review' };
    await prisma.skill.create({ data: { ...skill, sourceId: first.id, name: 'spec-review' } });
    await expect(
      prisma.skill.create({ data: { ...skill, sourceId: second.id, name: 'spec-review' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('cascades Skill and ProjectSkill rows when their SkillSource is deleted', async () => {
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p-cascade', key: 'PC' } });
    const owned = await prisma.skillSource.create({ data: source({ ref: 'cascade' }) });
    const skill = await prisma.skill.create({
      data: { sourceId: owned.id, name: 'cascade-skill', description: 'd', dir: 'cascade-skill' },
    });
    await prisma.projectSkill.create({ data: { projectId: project.id, skillId: skill.id } });

    await prisma.skillSource.delete({ where: { id: owned.id } });

    expect(await prisma.skill.count({ where: { id: skill.id } })).toBe(0);
    expect(await prisma.projectSkill.count({ where: { skillId: skill.id } })).toBe(0);
  });
});
