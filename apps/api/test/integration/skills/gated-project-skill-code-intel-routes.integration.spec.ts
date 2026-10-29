import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }

describeIntegration('gated project skills and code-intel writes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const skillPath = (id: string) => `/api/projects/web/skills/${id}`;
  const enable = (id: string, token = agent.apiKey) => request(server()).put(skillPath(id)).set(auth(token));
  const approve = async (id: string) => data<{ status: string }>(await request(server()).post(`/api/approvals/${id}/decisions`)
    .set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const skill = async () => {
    const n = ++seq;
    const source = await db.skillSource.create({ data: { gitUrl: `https://github.com/gate/skills-${n}`, owner: 'gate', repo: `skills-${n}`, ref: 'main', path: '.', status: 'OK', createdById: world.ids.root } });
    return db.skill.create({ data: { sourceId: source.id, name: `gated-skill-${n}`, description: '', dir: '.' } });
  };
  const index = (repoId: string) => request(server()).post('/api/code-intel/index').set(auth(agent.apiKey))
    .send({ projectSlug: 'web', repoId, commitHash: 'c1', files: [{ path: 'src/a.ts', content: 'export function alpha() { return 1; }' }] });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'skill.project.enable', 'skill.project.disable', 'codeintel.index.write'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });
  it('AC-1: enable waits in the project without enabling', async () => {
    const s = await skill();
    await seedWaitPolicy(db, 'skill.project.enable', world.projectId);
    expect(data<Pending>(await enable(s.id).expect(202))).toMatchObject({ permissionKey: 'skill.project.enable', projectId: world.projectId });
    expect(await db.projectSkill.count({ where: { skillId: s.id, projectId: world.projectId } })).toBe(0);
  });
  it('AC-2: freshly approved enable persists', async () => {
    const s = await skill();
    await seedWaitPolicy(db, 'skill.project.enable', world.projectId);
    const pending = data<Pending>(await enable(s.id).expect(202));
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.projectSkill.count({ where: { skillId: s.id, projectId: world.projectId } })).toBe(1);
  });
  it('AC-3: approved disable removes project enablement', async () => {
    const s = await skill();
    await enable(s.id, world.tokens.root).expect(200);
    await seedWaitPolicy(db, 'skill.project.disable', world.projectId);
    const pending = data<Pending>(await request(server()).delete(skillPath(s.id)).set(auth(agent.apiKey)).expect(202));
    expect(await db.projectSkill.count({ where: { skillId: s.id } })).toBe(1);
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.projectSkill.count({ where: { skillId: s.id } })).toBe(0);
  });
  it('AC-4: a deleted skill fails deferred enable', async () => {
    const s = await skill();
    await seedWaitPolicy(db, 'skill.project.enable', world.projectId);
    const pending = data<Pending>(await enable(s.id).expect(202));
    await db.skill.delete({ where: { id: s.id } });
    expect(await approve(pending.id)).toMatchObject({ status: 'failed' });
  });
  it('AC-5: index waits without storing symbols', async () => {
    const repoId = `gated-repo-${++seq}`;
    await seedWaitPolicy(db, 'codeintel.index.write', world.projectId);
    expect(data<Pending>(await index(repoId).expect(202))).toMatchObject({ permissionKey: 'codeintel.index.write', projectId: world.projectId });
    expect(await db.symbol.count({ where: { repoId } })).toBe(0);
  });
  it.each([6, 7])('AC-%i: freshly approved index stores symbols and exactly one audit', async () => {
    const repoId = `gated-repo-${++seq}`;
    await seedWaitPolicy(db, 'codeintel.index.write', world.projectId);
    const pending = data<Pending>(await index(repoId).expect(202));
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.symbol.count({ where: { repoId, commitHash: 'c1', projectId: world.projectId } })).toBeGreaterThan(0);
    const audits = await db.auditEntry.findMany({ where: { key: 'codeintel.index.write', resourceId: repoId } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resourceType: 'code-repo', projectId: world.projectId, summary: 'indexed 1 symbols in 1 files' });
  });
  it('AC-8: root enables immediately under wait with no approval row', async () => {
    const s = await skill();
    await seedWaitPolicy(db, 'skill.project.enable', world.projectId);
    expect(data<{ enabled: boolean }>(await enable(s.id, world.tokens.root).expect(200)).enabled).toBe(true);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
