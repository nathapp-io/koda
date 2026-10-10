/**
 * US-003 — admin skill source create + list routes (PG).
 *
 * GitHub is never called: the resolve method of the booted app's SKILL_RESOLVER is spied.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 npx jest --forceExit test/integration/skills/skills-routes.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { SKILL_RESOLVER, SkillResolveError, SkillResolver } from '../../../src/skills/skill-resolver';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('US-003 admin skill sources (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let admin: string;
  let member: string;
  let agentApiKey: string;
  let adminId: string;
  let resolve: jest.Mock;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sourceBody = (repo: string, path = 'skills') => ({
    gitUrl: `https://github.com/nathapp-io/${repo}`,
    ref: 'main',
    path,
  });
  const post = (b: Record<string, unknown>, token = admin) =>
    request(server).post('/api/admin/skills/sources').set(auth(token)).send(b);
  const list = (token = admin) => request(server).get('/api/admin/skills/sources').set(auth(token));

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
      .send({ name: 'Skill Agent', slug: 'skill-agent', roles: ['DEVELOPER'], capabilities: ['typescript'] })
      .expect(201);
    agentApiKey = data<{ apiKey: string }>(agentRes).apiKey;

    const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
    resolve = jest.spyOn(resolver, 'resolve');
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await prisma.skill.deleteMany();
    await prisma.skillSource.deleteMany();
    resolve.mockReset();
  });

  it('US-003 AC2: POST calls resolve once with the parsed owner, repo, ref and path', async () => {
    resolve.mockResolvedValue({ sha: 's1', skills: [{ name: 'spec-review', description: 'd', dir: 'skills/spec-review' }] });

    await post({ gitUrl: 'https://github.com/NathApp-IO/nax-spec-kit-skills.git', ref: 'main', path: 'skills' }).expect(201);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ owner: 'nathapp-io', repo: 'nax-spec-kit-skills', ref: 'main', path: 'skills' });
  });

  it('US-003 AC3: a successful resolution returns 201 with the pinned sha and resolved skills', async () => {
    const skills = [{ name: 'spec-review', description: 'd', dir: 'skills/spec-review' }];
    resolve.mockResolvedValue({ sha: 's1', skills });

    const dto = data<Record<string, unknown>>(
      await post({ gitUrl: 'https://github.com/NathApp-IO/nax-spec-kit-skills.git', ref: 'main', path: 'skills' }).expect(201),
    );

    expect(dto).toMatchObject({ status: 'OK', resolvedSha: 's1', skills });
  });

  it('US-003 AC4: a failed resolution is stored as RESOLVE_FAILED with the reason and no skills', async () => {
    resolve.mockRejectedValue(new SkillResolveError('rate_limited'));

    const dto = data<Record<string, unknown>>(
      await post(sourceBody('rate-limited-skills')).expect(201),
    );

    expect(dto).toMatchObject({ status: 'RESOLVE_FAILED', statusReason: 'rate_limited', skills: [] });
  });

  it('US-003 AC5: a non-GitHub URL is rejected with 400', async () => {
    await post({ gitUrl: 'https://gitlab.com/a/b', ref: 'main', path: '' }).expect(400);
  });

  it('US-003 AC6: a rejected non-GitHub URL writes no source row', async () => {
    const before = await prisma.skillSource.count();

    await post({ gitUrl: 'https://gitlab.com/a/b', ref: 'main', path: '' }).expect(400);

    expect(await prisma.skillSource.count()).toBe(before);
  });

  it('US-003 AC7: a name owned by another source returns 409', async () => {
    const name = 'shared-skill-name';
    resolve.mockResolvedValueOnce({ sha: 's1', skills: [{ name, description: 'd', dir: 'skills/a' }] });
    await post(sourceBody('first-skills')).expect(201);

    resolve.mockResolvedValueOnce({ sha: 's2', skills: [{ name, description: 'd', dir: 'skills/a' }] });
    await post(sourceBody('second-skills')).expect(409);
  });

  it('US-003 AC8: a name conflict rolls back the new source', async () => {
    const name = 'rollback-skill-name';
    resolve.mockResolvedValueOnce({ sha: 's1', skills: [{ name, description: 'd', dir: 'skills/a' }] });
    await post(sourceBody('rollback-first')).expect(201);
    const before = await prisma.skillSource.count();

    resolve.mockResolvedValueOnce({ sha: 's2', skills: [{ name, description: 'd', dir: 'skills/a' }] });
    await post(sourceBody('rollback-second')).expect(409);

    expect(await prisma.skillSource.count()).toBe(before);
  });

  it('US-003 AC9: a duplicate source returns 409 without resolving', async () => {
    resolve.mockResolvedValue({ sha: 's1', skills: [{ name: 'dup-skill', description: 'd', dir: 'skills/a' }] });
    const body = sourceBody('duplicate-skills');
    await post(body).expect(201);

    resolve.mockClear();
    await post(body).expect(409);

    expect(resolve).toHaveBeenCalledTimes(0);
  });

  it('US-003 AC10: an authenticated non-admin user cannot create a source', async () => {
    await post(sourceBody('member-attempt'), member).expect(403);
  });

  it('US-003 AC11: an agent API key cannot list sources', async () => {
    await list(agentApiKey).expect(403);
  });

  it('US-003 AC12: the admin list returns every source ordered by createdAt', async () => {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    const seeded = [];
    for (const offset of [2000, 0, 1000]) {
      seeded.push(
        await prisma.skillSource.create({
          data: {
            gitUrl: `https://github.com/nathapp-io/seed-${offset}`,
            owner: 'nathapp-io',
            repo: `seed-${offset}`,
            ref: 'main',
            path: '',
            status: 'OK',
            createdById: adminId,
            createdAt: new Date(base + offset),
          },
        }),
      );
    }
    const expected = seeded.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((s) => s.id);

    const dto = data<{ items: Array<{ id: string }> }>(await list().expect(200));

    expect(dto.items.map((s) => s.id)).toEqual(expected);
  });

  it('US-003 AC13: each listed source carries its skills ordered by name', async () => {
    const source = await prisma.skillSource.create({
      data: {
        gitUrl: 'https://github.com/nathapp-io/sorted-skills',
        owner: 'nathapp-io',
        repo: 'sorted-skills',
        ref: 'main',
        path: '',
        status: 'OK',
        createdById: adminId,
      },
    });
    for (const name of ['zeta', 'alpha', 'mike']) {
      await prisma.skill.create({ data: { sourceId: source.id, name: `${name}-skill`, description: 'd', dir: name } });
    }

    const dto = data<{ items: Array<{ id: string; skills: Array<{ name: string }> }> }>(await list().expect(200));
    const listed = dto.items.find((s) => s.id === source.id);

    expect(listed?.skills.map((s) => s.name)).toEqual(['alpha-skill', 'mike-skill', 'zeta-skill']);
  });

  it('US-003 AC14: a traversal path is rejected with 400 without resolving', async () => {
    await post(sourceBody('traversal-skills', '../x')).expect(400);

    expect(resolve).toHaveBeenCalledTimes(0);
  });

  it('US-003 AC15: a ref containing .. is rejected with 400 without resolving', async () => {
    await post({ ...sourceBody('bad-ref-skills'), ref: 'a..b' }).expect(400);

    expect(resolve).toHaveBeenCalledTimes(0);
  });
});
