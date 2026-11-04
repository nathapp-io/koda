import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { FleetPrRulingsService } from '../../../src/fleet/rulings/fleet-pr-rulings.service';

(canRunDbTests() ? describe : describe.skip)('fleet ruling routes and approval replay (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let seq = 0;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (id: string, body = { itemId: 'D-1', text: 'confirm: test green' }, token = agent.apiKey) => request(server()).post(`/api/projects/web/fleet/jobs/${id}/rulings`).set(auth(token)).send(body);
  const job = () => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, command: 'RUN', feature: `ruling-${++seq}`, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: agent.id,
    resultPrUrl: `https://github.com/acme/app/pull/${seq}`, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'review' }] },
  } });
  const humanPolicy = async () => {
    const policy = await seedWaitPolicy(db, 'fleet.job.rule', world.projectId);
    await db.approvalPolicy.update({ where: { id: policy.id }, data: { mode: 'human' } });
  };
  const approve = async (id: string) => data<{ status: string; result: unknown }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'AGENT', id: agent.id }, 'developer', world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => { await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany(); });
  afterAll(async () => { await app?.close(); });
  const noWrites = async (jobId: string) => {
    expect(await db.fleetPrRuling.count({ where: { jobId } })).toBe(0);
    expect(await db.approvalRequest.count()).toBe(0);
  };
  it('AC-1: developer agent creates a confirmed pending ruling', async () => {
    const j = await job();
    expect(data(await post(j.id).expect(201))).toMatchObject({ jobId: j.id, state: 'pending', disposition: 'confirmed', actorType: 'AGENT', actorId: agent.id });
  });
  it.each(['ready', 'PLAN', 'no-pr', 'wrong-repo', 'gitlab'])('AC-2: refuses non-draft target %s before gate', async (kind) => {
    const j = await job();
    await humanPolicy();
    if (kind === 'ready') await db.fleetJob.update({ where: { id: j.id }, data: { workflow: { outcome: 'ready' } } });
    if (kind === 'PLAN') await db.fleetJob.update({ where: { id: j.id }, data: { command: 'PLAN' } });
    if (kind === 'no-pr') await db.fleetJob.update({ where: { id: j.id }, data: { resultPrUrl: null } });
    if (kind === 'wrong-repo') await db.fleetJob.update({ where: { id: j.id }, data: { resultPrUrl: 'https://github.com/other/repo/pull/1' } });
    if (kind === 'gitlab') {
      const repo = await db.fleetRepo.create({ data: { projectId: world.projectId, provider: 'gitlab', owner: 'acme', name: 'ruling-gitlab', defaultBranch: 'main', createdById: world.ids.root } });
      await db.fleetJob.update({ where: { id: j.id }, data: { repoId: repo.id, resultPrUrl: 'https://gitlab.com/acme/ruling-gitlab/-/merge_requests/1' } });
    }
    const response = await post(j.id).expect(409);
    expect(JSON.stringify(response.body)).toContain('Only draft RUN jobs with a GitHub pull request can be ruled');
    await noWrites(j.id);
  });
  it('AC-3: rejects unknown item before gate', async () => {
    const j = await job(); await humanPolicy();
    expect(JSON.stringify((await post(j.id, { itemId: 'Z-9', text: 'verified' }).expect(404)).body)).toContain('Workflow item not found');
    await noWrites(j.id);
  });
  it.each(['looks fine', 'waive', 'override', 'confirm'])('AC-4: invalid text %s writes nothing', async (text) => {
    const j = await job(); await humanPolicy();
    expect(JSON.stringify((await post(j.id, { itemId: 'D-1', text }).expect(400)).body)).toContain('text');
    await noWrites(j.id);
  });
  it('AC-5/14: cross-project and unknown jobs fail before gate', async () => {
    const j = await job(); await humanPolicy();
    await db.fleetJob.update({ where: { id: j.id }, data: { projectId: world.opsProjectId, repoId: world.foreignRepoId } });
    expect((await post(j.id).expect(404)).body.message).toBe('Fleet job not found'); expect((await post('missing').expect(404)).body.message).toBe('Fleet job not found'); await noWrites(j.id);
  });
  it('AC-6: viewer gets 403 before target read', async () => {
    const j = await job();
    await db.fleetJob.update({ where: { id: j.id }, data: { workflow: { outcome: 'ready' } } });
    const spy = vi.spyOn(app.get(FleetPrRulingsService), 'ruleTarget');
    try { await post(j.id, undefined, world.tokens.viewer).expect(403); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
    await noWrites(j.id);
  });
  it('AC-7: only latest RUN may be ruled', async () => {
    const j = await job(); const newer = await job(); await humanPolicy();
    await db.fleetJob.update({ where: { id: newer.id }, data: { resultPrUrl: j.resultPrUrl, createdAt: new Date(j.createdAt.getTime() + 1000) } });
    expect(JSON.stringify((await post(j.id).expect(409)).body)).toContain('Only the latest RUN of this pull request can be ruled'); await noWrites(j.id);
  });
  it('AC-7: requeue time does not make an older RUN the latest', async () => {
    const older = await job(); const newer = await job();
    await db.fleetJob.update({ where: { id: newer.id }, data: { resultPrUrl: older.resultPrUrl } });
    await db.fleetJob.update({ where: { id: older.id }, data: { queuedAt: new Date(Date.now() + 60000) } });
    await post(older.id).expect(409);
    await post(newer.id).expect(201);
  });
  it('AC-8: applied item is settled before gate', async () => {
    const j = await job(); const ruling = data<{ id: string }>(await post(j.id).expect(201));
    await db.fleetPrRuling.update({ where: { id: ruling.id }, data: { state: 'applied' } }); await humanPolicy();
    expect(JSON.stringify((await post(j.id).expect(409)).body)).toContain('This item has already been applied');
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(1);
  });
  it('AC-9/10: human policy defers write and executes as requesting agent', async () => {
    const j = await job(); await humanPolicy();
    const pending = data<{ id: string }>(await post(j.id).expect(202));
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(0);
    expect((await approve(pending.id)).status).toBe('executed');
    expect(await db.fleetPrRuling.findMany({ where: { jobId: j.id } })).toEqual([expect.objectContaining({ state: 'pending', actorType: 'AGENT', actorId: agent.id, approvalRequestId: pending.id })]);
  });
  it.each(['ready', 'applied', 'newer', 'unknown'])('AC-11/15: stale approval %s fails without new ruling', async (change) => {
    const j = await job(); await humanPolicy();
    const pending = data<{ id: string }>(await post(j.id).expect(202));
    if (change === 'ready') await db.fleetJob.update({ where: { id: j.id }, data: { workflow: { outcome: 'ready' } } });
    if (change === 'unknown') await db.fleetJob.update({ where: { id: j.id }, data: { workflow: { outcome: 'draft', openItems: [] } } });
    if (change === 'newer') { const newer = await job(); await db.fleetJob.update({ where: { id: newer.id }, data: { resultPrUrl: j.resultPrUrl, createdAt: new Date(j.createdAt.getTime() + 1000) } }); }
    if (change === 'applied') await db.fleetPrRuling.create({ data: { projectId: world.projectId, repoId: world.repoId, prNumber: seq, jobId: j.id, itemId: 'D-1', itemKind: 'review', text: 'verified', disposition: 'verified', actorType: 'USER', actorId: world.ids.root, state: 'applied' } });
    const count = await db.fleetPrRuling.count({ where: { jobId: j.id } });
    const spy = vi.spyOn(app.get(FleetPrRulingsService), 'ruleTarget');
    try {
      expect((await approve(pending.id)).status).toBe('failed');
      expect(spy).toHaveBeenCalledExactlyOnceWith(world.projectId, j.id, { itemId: 'D-1', text: 'confirm: test green' });
      const prefix = { ready: 'notDraft', applied: 'settled', newer: 'notLatest', unknown: 'unknownItem' }[change];
      await expect(spy.mock.results[0].value).rejects.toMatchObject({ prefix: `fleet.rulings.${prefix}` });
    } finally { spy.mockRestore(); }
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(count);
  });
  it('AC-12: lists every state newest first and prevents cross-project reads', async () => {
    const j = await job();
    const first = data<{ id: string }>(await post(j.id).expect(201));
    await db.fleetPrRuling.update({ where: { id: first.id }, data: { createdAt: new Date(0) } });
    const second = data<{ id: string }>(await post(j.id).expect(201));
    const historic = await db.fleetPrRuling.findUniqueOrThrow({ where: { id: first.id } });
    const applied = await db.fleetPrRuling.create({ data: { ...historic, id: undefined, state: 'applied', createdAt: new Date(-1000) } });
    const skipped = await db.fleetPrRuling.create({ data: { ...historic, id: undefined, state: 'skipped', createdAt: new Date(-2000) } });
    const response = await request(server()).get(`/api/projects/web/fleet/jobs/${j.id}/rulings`).set(auth(world.tokens.viewer)).expect(200);
    expect(data<{ id: string; state: string }[]>(response).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: second.id, state: 'pending' }, { id: first.id, state: 'replaced' }, { id: applied.id, state: 'applied' }, { id: skipped.id, state: 'skipped' },
    ]);
    await request(server()).get(`/api/projects/ops/fleet/jobs/${j.id}/rulings`).set(auth(world.tokens.root)).expect(404);
  });
});
