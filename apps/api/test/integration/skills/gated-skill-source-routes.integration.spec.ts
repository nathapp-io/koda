import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitHubSkillResolver } from '../../../src/skills/github-skill-resolver';
import { SkillResolveError } from '../../../src/skills/skill-resolver';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: null }

describeIntegration('gated skill source writes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let resolve: ReturnType<typeof vi.spyOn<GitHubSkillResolver, 'resolve'>>;
  let seq = 0;
  let body: { gitUrl: string; ref: string; path: string };
  let skills: Array<{ name: string; description: string; dir: string }>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const create = (token = agent.apiKey, source = body) => request(server()).post('/api/admin/skills/sources').set(auth(token)).send(source);
  const approve = async (id: string) => data<{ status: string; result: { error?: string } }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const pendingCreate = async () => {
    await seedWaitPolicy(db, 'skill.source.create', null);
    return data<Pending>(await create().expect(202));
  };
  const pendingUpdate = async () => {
    const source = data<{ id: string }>(await create(world.tokens.root).expect(201));
    await seedWaitPolicy(db, 'skill.source.update', null);
    const pending = data<Pending>(await request(server()).post(`/api/admin/skills/sources/${source.id}/update`).set(auth(agent.apiKey)).send({}).expect(202));
    resolve.mockClear();
    return { source, pending };
  };
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['skill.source.create', 'skill.source.update'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  beforeEach(async () => {
    await resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    const n = ++seq;
    body = { gitUrl: `https://github.com/gated/source-${n}`, ref: 'main', path: 'skills' };
    skills = [{ name: `source-gate-${n}`, description: 'stub', dir: 'skills/stub' }];
    resolve = vi.spyOn(GitHubSkillResolver.prototype, 'resolve').mockResolvedValue({ sha: 'stub-sha', skills });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); });

  it('AC-1: create waits globally without resolving', async () => {
    expect(await pendingCreate()).toMatchObject({ permissionKey: 'skill.source.create', projectId: null });
    expect(resolve).not.toHaveBeenCalled();
    expect(await db.skillSource.count({ where: { gitUrl: body.gitUrl } })).toBe(0);
  });
  it('AC-2: approved create stores the resolved skill and audit', async () => {
    const pending = await pendingCreate();
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    const sources = await db.skillSource.findMany({ where: { gitUrl: body.gitUrl }, include: { skills: true } });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ status: 'OK', skills: [expect.objectContaining(skills[0])] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await db.auditEntry.count({ where: { key: 'skill.source.create', resourceId: sources[0].id } })).toBe(1);
  });
  it('AC-3: source registered while waiting fails execution', async () => {
    const pending = await pendingCreate();
    await create(world.tokens.root).expect(201);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
  });
  it('AC-4: known resolution failure persists and executes', async () => {
    const pending = await pendingCreate();
    resolve.mockRejectedValue(new SkillResolveError('no_skills'));
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.skillSource.findFirstOrThrow({ where: { gitUrl: body.gitUrl } })).toMatchObject({ status: 'RESOLVE_FAILED', statusReason: 'no_skills' });
  });
  it('AC-5: approved update replaces the skills', async () => {
    const { source, pending } = await pendingUpdate();
    const updated = [{ name: `updated-${seq}`, description: 'new', dir: 'skills/new' }];
    resolve.mockResolvedValue({ sha: 'new-sha', skills: updated });
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.skill.findMany({ where: { sourceId: source.id } })).toEqual([expect.objectContaining(updated[0])]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('AC-6: deleted source fails deferred update', async () => {
    const { source, pending } = await pendingUpdate();
    await request(server()).delete(`/api/admin/skills/sources/${source.id}`).set(auth(world.tokens.root)).expect(204);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
  });
  it('AC-7: root creates immediately under wait without approval', async () => {
    await seedWaitPolicy(db, 'skill.source.create', null);
    await create(world.tokens.root).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-14: unexpected preparation failure stores nothing', async () => {
    const pending = await pendingCreate();
    resolve.mockRejectedValue(new Error('provider unavailable'));
    expect(await approve(pending.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await db.skillSource.count({ where: { gitUrl: body.gitUrl } })).toBe(0);
  });
  it('AC-15 (brief AC-16): name taken while waiting fails execution', async () => {
    const pending = await pendingCreate();
    await create(world.tokens.root, { ...body, gitUrl: `https://github.com/gated/other-${seq}` }).expect(201);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
    expect(await db.skillSource.count({ where: { gitUrl: body.gitUrl } })).toBe(0);
  });
});
