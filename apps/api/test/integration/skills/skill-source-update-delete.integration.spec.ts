import type { Mock } from 'vitest';
/**
 * US-004 — admin skill source update + delete routes (PG).
 *
 * GitHub is never called: the resolve method of the booted app's SKILL_RESOLVER is spied.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx jest --forceExit test/integration/skills/skill-source-update-delete.integration.spec.ts
 */
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { SKILL_RESOLVER, SkillResolveError, SkillResolver } from '../../../src/skills/skill-resolver';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface SkillPart {
  name: string;
  description: string;
  dir: string;
}

interface SkillRow extends SkillPart {
  id: string;
}

interface SourceDto {
  id: string;
  status: string;
  statusReason: string | null;
  resolvedSha: string | null;
  resolvedAt: string | null;
  skills: SkillRow[];
}

/** The refusal sentence declared in src/i18n/en/<namespace>.json for `<namespace>.<key>`. */
function i18nSentence(namespace: string, key: string): string {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;
  const sentence = key
    .split('.')
    .reduce<unknown>((node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined), catalog);
  if (typeof sentence !== 'string') throw new Error(`${namespace}.${key} is not declared in the en catalog`);
  return sentence;
}

describeIntegration('US-004 admin skill source update + delete (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let admin: string;
  let member: string;
  let agentApiKey: string;
  let adminId: string;
  let projectId: string;
  let resolve: Mock;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const update = (id: string, token = admin) =>
    request(server).post(`/api/admin/skills/sources/${id}/update`).set(auth(token)).send({});
  const remove = (id: string, token = admin) =>
    request(server).delete(`/api/admin/skills/sources/${id}`).set(auth(token));

  /** Seeds a source with `resolvedSha: 'sha-before'` and returns it with its skill rows keyed by name. */
  async function seedSource(repo: string, skills: SkillPart[]): Promise<{ sourceId: string; byName: Record<string, SkillRow> }> {
    const source = await prisma.skillSource.create({
      data: {
        gitUrl: `https://github.com/nathapp-io/${repo}`,
        owner: 'nathapp-io',
        repo,
        ref: 'main',
        path: '',
        status: 'OK',
        resolvedSha: 'sha-before',
        resolvedAt: new Date('2024-01-01T00:00:00.000Z'),
        createdById: adminId,
      },
    });
    const byName: Record<string, SkillRow> = {};
    for (const skill of skills) {
      const row = await prisma.skill.create({ data: { sourceId: source.id, ...skill } });
      byName[skill.name] = { id: row.id, name: row.name, description: row.description, dir: row.dir };
    }
    return { sourceId: source.id, byName };
  }

  /** Asserts a 404 carrying the domain refusal sentence (a missing route would not). */
  function expectSourceNotFound(res: request.Response): void {
    expect(res.status).toBe(404);
    const envelope = res.body as { ret?: unknown; message?: unknown };
    expect(envelope.ret).toBeDefined();
    expect(envelope.message).toBe(i18nSentence('skills', 'sourceNotFound.404'));
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;

    // The first registered user becomes the global ADMIN.
    const adminRes = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    admin = data<{ accessToken: string }>(adminRes).accessToken;
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    await request(server)
      .post('/api/admin/users')
      .set(auth(admin))
      .send({ email: 'member@koda.test', name: 'Member', password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    member = await loginToken(server, 'member@koda.test');

    const agentRes = await request(server)
      .post('/api/agents')
      .set(auth(admin))
      .send({ name: 'Skill Update Agent', slug: 'skill-update-agent', roles: ['DEVELOPER'], capabilities: ['typescript'] })
      .expect(201);
    agentApiKey = data<{ apiKey: string }>(agentRes).apiKey;

    projectId = (
      await prisma.project.create({ data: { name: 'Skills Project', slug: 'skills-project', key: 'SKL' } })
    ).id;

    const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
    resolve = vi.spyOn(resolver, 'resolve');
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await prisma.projectSkill.deleteMany();
    await prisma.skillSource.deleteMany(); // cascades Skill rows
    resolve.mockReset();
  });

  // ── AC1 — replace in place ───────────────────────────────────────

  it('US-004 AC1: update keeps the surviving skill id and dir, drops vanished names and inserts new ones', async () => {
    const { sourceId, byName } = await seedSource('update-replace', [
      { name: 'a', description: 'old', dir: 'skills/a' },
      { name: 'b', description: 'old-b', dir: 'skills/b' },
    ]);
    await prisma.skillSource.update({
      where: { id: sourceId },
      data: { owner: 'stored-owner', repo: 'stored-repo', ref: 'release/v2', path: 'nested/skills' },
    });
    resolve.mockResolvedValue({
      sha: 'sha-after',
      skills: [
        { name: 'a', description: 'new', dir: 'skills/a-renamed' },
        { name: 'c', description: 'new-c', dir: 'skills/c' },
      ],
    });

    const dto = data<SourceDto>(await update(sourceId).expect(200));

    expect(resolve).toHaveBeenCalledWith({ owner: 'stored-owner', repo: 'stored-repo', ref: 'release/v2', path: 'nested/skills' });
    expect(dto.status).toBe('OK');
    expect(dto.resolvedSha).toBe('sha-after');
    expect(dto.skills.map((s) => s.name)).toEqual(['a', 'c']);
    const byNameAfter = Object.fromEntries(dto.skills.map((s) => [s.name, s]));
    expect(byNameAfter.a).toEqual({ id: byName.a.id, name: 'a', description: 'new', dir: 'skills/a-renamed' });
    expect(byNameAfter.c.id).toEqual(expect.any(String));
    expect(byNameAfter.c).toMatchObject({ name: 'c', description: 'new-c', dir: 'skills/c' });
  });

  // ── AC2/AC3 — project enablements survive / cascade ───────────────

  it('US-004 AC2: a surviving skill keeps its ProjectSkill row', async () => {
    const { sourceId, byName } = await seedSource('update-project-survive', [
      { name: 'a', description: 'old', dir: 'skills/a' },
      { name: 'b', description: 'old-b', dir: 'skills/b' },
    ]);
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.a.id } });
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.b.id } });
    resolve.mockResolvedValue({
      sha: 'sha-after',
      skills: [
        { name: 'a', description: 'new', dir: 'skills/a' },
        { name: 'c', description: 'new-c', dir: 'skills/c' },
      ],
    });

    await update(sourceId).expect(200);

    const row = await prisma.projectSkill.findUnique({ where: { projectId_skillId: { projectId, skillId: byName.a.id } } });
    expect(row).not.toBeNull();
  });

  it('US-004 AC3: a vanished skill drops its ProjectSkill row', async () => {
    const { sourceId, byName } = await seedSource('update-project-drop', [
      { name: 'a', description: 'old', dir: 'skills/a' },
      { name: 'b', description: 'old-b', dir: 'skills/b' },
    ]);
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.a.id } });
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.b.id } });
    resolve.mockResolvedValue({
      sha: 'sha-after',
      skills: [
        { name: 'a', description: 'new', dir: 'skills/a' },
        { name: 'c', description: 'new-c', dir: 'skills/c' },
      ],
    });

    await update(sourceId).expect(200);

    const row = await prisma.projectSkill.findUnique({ where: { projectId_skillId: { projectId, skillId: byName.b.id } } });
    expect(row).toBeNull();
  });

  // ── AC4 — resolve failure keeps the pin ───────────────────────────

  it('US-004 AC4: a resolve failure returns 200 with RESOLVE_FAILED and keeps the previous pin and skills', async () => {
    const { sourceId, byName } = await seedSource('update-resolve-failed', [
      { name: 'a', description: 'da', dir: 'skills/a' },
      { name: 'b', description: 'db', dir: 'skills/b' },
    ]);
    resolve.mockRejectedValue(new SkillResolveError('not_public_or_missing'));

    const dto = data<SourceDto>(await update(sourceId).expect(200));

    expect(dto).toMatchObject({
      status: 'RESOLVE_FAILED',
      statusReason: 'not_public_or_missing',
      resolvedSha: 'sha-before',
    });
    expect(dto.skills).toEqual([byName.a, byName.b]);
  });

  // ── AC5/AC6 — name conflict changes nothing ───────────────────────

  it('US-004 AC5: a resolution owning another source\u2019s name returns 409', async () => {
    await seedSource('update-owner-source', [{ name: 'owned-elsewhere', description: 'd', dir: 'skills/owned' }]);
    const { sourceId } = await seedSource('update-conflicting-source', [{ name: 'a', description: 'd', dir: 'skills/a' }]);
    resolve.mockResolvedValue({ sha: 'sha-new', skills: [{ name: 'owned-elsewhere', description: 'd2', dir: 'skills/owned' }] });

    await update(sourceId).expect(409);
  });

  it('US-004 AC6: a 409 name conflict leaves status, sha and skills untouched', async () => {
    await seedSource('update-owner-source-6', [{ name: 'owned-elsewhere-6', description: 'd', dir: 'skills/owned' }]);
    const { sourceId, byName } = await seedSource('update-conflicting-source-6', [
      { name: 'a6', description: 'da', dir: 'skills/a6' },
      { name: 'b6', description: 'db', dir: 'skills/b6' },
    ]);
    resolve.mockResolvedValue({ sha: 'sha-new', skills: [{ name: 'owned-elsewhere-6', description: 'd2', dir: 'skills/owned' }] });

    await update(sourceId).expect(409);

    const after = await prisma.skillSource.findUniqueOrThrow({
      where: { id: sourceId },
      include: { skills: { orderBy: { name: 'asc' } } },
    });
    expect(after.status).toBe('OK');
    expect(after.resolvedSha).toBe('sha-before');
    expect(after.resolvedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(after.statusReason).toBeNull();
    expect(after.skills.map((s) => s.id)).toEqual([byName.a6.id, byName.b6.id]);
  });

  // ── AC7 — unknown id ──────────────────────────────────────────────

  it('US-004 AC7: update of an unknown id returns 404', async () => {
    const res = await update('unknown-source-id');
    expectSourceNotFound(res);
  });

  // ── AC8/AC9/AC10 — delete ─────────────────────────────────────────

  it('US-004 AC8: a global admin deletes a source and receives 204', async () => {
    const { sourceId } = await seedSource('delete-204', [{ name: 'a', description: 'd', dir: 'skills/a' }]);

    await remove(sourceId).expect(204);
  });

  it('US-004 AC9: delete cascades the source\u2019s skills and their project enablements', async () => {
    const { sourceId, byName } = await seedSource('delete-cascade', [
      { name: 'a', description: 'd', dir: 'skills/a' },
      { name: 'b', description: 'd', dir: 'skills/b' },
    ]);
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.a.id } });
    await prisma.projectSkill.create({ data: { projectId, skillId: byName.b.id } });

    await remove(sourceId).expect(204);

    expect(await prisma.skill.count({ where: { sourceId } })).toBe(0);
    expect(
      await prisma.projectSkill.count({ where: { skillId: { in: [byName.a.id, byName.b.id] } } }),
    ).toBe(0);
  });

  it('US-004 AC10: delete of an unknown id returns 404', async () => {
    const res = await remove('unknown-source-id');
    expectSourceNotFound(res);
  });

  // ── AC11/AC12/AC13 — authorization ────────────────────────────────

  it('US-004 AC11: delete by a non-admin user returns 403', async () => {
    const { sourceId } = await seedSource('delete-member', [{ name: 'a', description: 'd', dir: 'skills/a' }]);

    await remove(sourceId, member).expect(403);
  });

  it('US-004 AC12: update by a non-admin user returns 403', async () => {
    const { sourceId } = await seedSource('update-member', [{ name: 'a', description: 'd', dir: 'skills/a' }]);

    await update(sourceId, member).expect(403);
  });

  it('US-004 AC13: update with an agent API key returns 403', async () => {
    const { sourceId } = await seedSource('update-agent', [{ name: 'a', description: 'd', dir: 'skills/a' }]);

    await update(sourceId, agentApiKey).expect(403);
  });

  // ── AC14/AC15 — statusReason formatting ───────────────────────────

  it('US-004 AC14: a resolve failure with detail stores "reason:detail"', async () => {
    const { sourceId } = await seedSource('update-reason-detail', [{ name: 'a', description: 'd', dir: 'skills/a' }]);
    resolve.mockRejectedValue(new SkillResolveError('invalid_skill', 'skills/x'));

    const dto = data<SourceDto>(await update(sourceId).expect(200));

    expect(dto.status).toBe('RESOLVE_FAILED');
    expect(dto.statusReason).toBe('invalid_skill:skills/x');
  });

  it('US-004 AC15: a long failure reason is truncated to 300 characters', async () => {
    const { sourceId } = await seedSource('update-reason-truncated', [{ name: 'a', description: 'd', dir: 'skills/a' }]);
    const detail = 'x'.repeat(400);
    resolve.mockRejectedValue(new SkillResolveError('invalid_skill', detail));

    const dto = data<SourceDto>(await update(sourceId).expect(200));

    expect(dto.statusReason).toHaveLength(300);
    expect(dto.statusReason).toBe(`invalid_skill:${detail}`.slice(0, 300));
  });
});
