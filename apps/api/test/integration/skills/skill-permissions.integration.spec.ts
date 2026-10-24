import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { SkillResolver, SKILL_RESOLVER } from '../../../src/skills/skill-resolver';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const PROJECT = 'skill-permissions-p1';
const SYSTEM = { type: 'SYSTEM' as const, id: 'skills-permissions-test' };

describeIntegration('US-006 skills route permissions', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let projectId: string;
  let resolve: ReturnType<typeof vi.spyOn>;
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const agentIds: Record<string, string> = {};
  const agentKeys: Record<string, string> = {};

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const error = (res: request.Response, code: 'permissions' | 'projects') => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(code === 'permissions'
      ? 'You do not have permissions to perform this action'
      : 'projects.40003');
  };
  const listSources = (token: string) => request(server).get('/api/admin/skills/sources').set(auth(token));
  const createSource = (token: string, repo: string) => request(server).post('/api/admin/skills/sources').set(auth(token))
    .send({ gitUrl: `https://github.com/nathapp-io/${repo}`, ref: 'main', path: 'skills' });
  const listSkills = (token: string, slug = PROJECT) => request(server).get(`/api/projects/${slug}/skills`).set(auth(token));
  const enable = (token: string, skillId: string) => request(server).put(`/api/projects/${PROJECT}/skills/${skillId}`).set(auth(token)).send({});
  const disable = (token: string, skillId: string) => request(server).delete(`/api/projects/${PROJECT}/skills/${skillId}`).set(auth(token));

  async function seedSkill(name: string): Promise<string> {
    const source = await db.skillSource.create({ data: {
      gitUrl: `https://github.com/nathapp-io/${name}`, owner: 'nathapp-io', repo: name, ref: 'main', path: '',
      status: 'OK', createdById: userIds.root as string,
    } });
    return (await db.skill.create({ data: { sourceId: source.id, name, description: name, dir: name } })).id;
  }

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    const root = await request(server).post('/api/auth/register').send({
      email: 'skills-permissions-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    userIds.root = (await db.user.findUniqueOrThrow({
      where: { email: 'skills-permissions-root@koda.test' }, select: { id: true },
    })).id;

    const project = await request(server).post('/api/projects').set(auth(tokens.root)).send({
      name: 'Skills Permissions', slug: PROJECT, key: 'SPM',
    }).expect(201);
    projectId = data<{ id: string }>(project).id;

    for (const who of ['viewer', 'developer', 'admin', 'outsider']) {
      await request(server).post('/api/admin/users').set(auth(tokens.root)).send({
        email: `skills-permissions-${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER',
      }).expect(201);
      userIds[who] = (await db.user.findUniqueOrThrow({
        where: { email: `skills-permissions-${who}@koda.test` }, select: { id: true },
      })).id;
      tokens[who] = await loginToken(server, `skills-permissions-${who}@koda.test`);
    }
    for (const [who, roleKey] of [['viewer', 'viewer'], ['developer', 'developer'], ['admin', 'project-admin']] as const) {
      await membership.createBinding({ principal: { type: 'USER', id: userIds[who] as string }, roleKey, projectId }, SYSTEM);
    }

    for (const who of ['baseline', 'admin']) {
      const created = await request(server).post('/api/agents').set(auth(tokens.root)).send({
        name: `Skills ${who}`, slug: `skills-permissions-${who}`, capabilities: [],
      }).expect(201);
      agentKeys[who] = data<{ apiKey: string }>(created).apiKey;
      agentIds[who] = (await db.agent.findUniqueOrThrow({
        where: { slug: `skills-permissions-${who}` }, select: { id: true },
      })).id;
    }
    await membership.createBinding({ principal: { type: 'AGENT', id: agentIds.admin as string }, roleKey: 'admin', projectId: null }, SYSTEM);

    const resolver = app.get<SkillResolver>(SKILL_RESOLVER, { strict: false });
    resolve = vi.spyOn(resolver, 'resolve').mockResolvedValue({ sha: 'sha-agent', skills: [] });
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it('AC-1: non-admin user cannot list sources with a permissions refusal', async () => {
    error(await listSources(tokens.viewer), 'permissions');
  });

  it('AC-2: global admin can list sources', async () => {
    await listSources(tokens.root).expect(200);
  });

  it('AC-3: denied source update and delete preserve the source and return permissions', async () => {
    const source = await db.skillSource.create({ data: {
      gitUrl: 'https://github.com/nathapp-io/denied-update', owner: 'nathapp-io', repo: 'denied-update',
      ref: 'main', path: '', status: 'OK', createdById: userIds.root as string,
    } });
    error(await request(server).post(`/api/admin/skills/sources/${source.id}/update`).set(auth(tokens.viewer)).send({}), 'permissions');
    expect(await db.skillSource.findUnique({ where: { id: source.id } })).not.toBeNull();
    error(await request(server).delete(`/api/admin/skills/sources/${source.id}`).set(auth(tokens.viewer)), 'permissions');
    expect(await db.skillSource.findUnique({ where: { id: source.id } })).not.toBeNull();
  });

  it('AC-4: baseline-only agent cannot create a source with a permissions refusal', async () => {
    error(await createSource(agentKeys.baseline as string, 'baseline-agent-source'), 'permissions');
  });

  it('AC-5: globally bound agent creates a source attributed to its principal id', async () => {
    const created = data<{ id: string }>(await createSource(agentKeys.admin as string, 'bound-agent-source').expect(201));
    expect(resolve).toHaveBeenCalledWith({ owner: 'nathapp-io', repo: 'bound-agent-source', ref: 'main', path: 'skills' });
    const source = await db.skillSource.findUniqueOrThrow({ where: { id: created.id } });
    expect(source.createdById).toBe(agentIds.admin);
  });

  it('AC-7 and AC-8: viewer-bound user and agent can list project skills', async () => {
    const skillId = await seedSkill('viewer-visible');
    await membership.createBinding({ principal: { type: 'AGENT', id: agentIds.baseline as string }, roleKey: 'viewer', projectId }, SYSTEM);
    const userItems = data<{ items: Array<{ id: string }> }>(await listSkills(tokens.viewer).expect(200)).items;
    const agentItems = data<{ items: Array<{ id: string }> }>(await listSkills(agentKeys.baseline as string).expect(200)).items;
    expect(userItems.map(({ id }) => id)).toContain(skillId);
    expect(agentItems.map(({ id }) => id)).toContain(skillId);
  });

  it('AC-9: developer-bound user cannot enable and no row is written', async () => {
    const skillId = await seedSkill('developer-denied');
    error(await enable(tokens.developer as string, skillId), 'permissions');
    expect(await db.projectSkill.findUnique({ where: { projectId_skillId: { projectId, skillId } } })).toBeNull();
  });

  it('AC-10 and AC-11: project-admin user and agent can enable with caller attribution', async () => {
    const skillId = await seedSkill('admin-enabled');
    await membership.createBinding({ principal: { type: 'AGENT', id: agentIds.admin as string }, roleKey: 'project-admin', projectId }, SYSTEM);
    await enable(tokens.admin as string, skillId).expect(200);
    expect((await db.projectSkill.findUniqueOrThrow({ where: { projectId_skillId: { projectId, skillId } } })).enabledById).toBe(userIds.admin);
    await db.projectSkill.delete({ where: { projectId_skillId: { projectId, skillId } } });
    await enable(agentKeys.admin as string, skillId).expect(200);
    expect((await db.projectSkill.findUniqueOrThrow({ where: { projectId_skillId: { projectId, skillId } } })).enabledById).toBe(agentIds.admin);
  });

  it('AC-12: project-admin user can disable and removes the row', async () => {
    const skillId = await seedSkill('admin-disabled');
    await db.projectSkill.create({ data: { projectId, skillId, enabledById: userIds.admin as string } });
    await disable(tokens.admin as string, skillId).expect(204);
    expect(await db.projectSkill.findUnique({ where: { projectId_skillId: { projectId, skillId } } })).toBeNull();
  });

  it('AC-13: developer-bound user cannot disable and the row remains', async () => {
    const skillId = await seedSkill('developer-disable-denied');
    await db.projectSkill.create({ data: { projectId, skillId, enabledById: userIds.admin as string } });
    error(await disable(tokens.developer as string, skillId), 'permissions');
    expect(await db.projectSkill.findUnique({ where: { projectId_skillId: { projectId, skillId } } })).not.toBeNull();
  });

  it('AC-14: principal without project access is refused with projects code', async () => {
    error(await listSkills(tokens.outsider as string), 'projects');
  });
});
