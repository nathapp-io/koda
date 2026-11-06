import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import type { ToolCaller } from '../../../src/fleet/assistant/assistant-tool.types';
import { FleetPrRulingsService } from '../../../src/fleet/rulings/fleet-pr-rulings.service';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('assistant PR rulings (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let caller: ToolCaller;
  let seq = 900;
  const saved = process.env.FLEET_THREADS_ENABLED;
  beforeAll(async () => {
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    caller = { principal: { actorType: 'agent', id: agent.id, slug: agent.slug, name: 'claude', status: 'ACTIVE', agentRoles: ['DEVELOPER'], capabilities: [], authorities: [], blacklisted: false, revoked: false }, origin: { kind: 'mcp' }, disabled: false };
  }, 120000);
  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.FLEET_THREADS_ENABLED; else process.env.FLEET_THREADS_ENABLED = saved;
  });
  const job = () => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, command: 'RUN', feature: `tool-${++seq}`, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: agent.id,
    resultPrUrl: `https://github.com/acme/app/pull/${seq}`, workflow: { outcome: 'draft', openItems: [{ id: 'D-1', kind: 'advisor' }] },
  } });
  const execute = (jobId: string, itemId = 'D-1') => app.get(AssistantToolExecutor).executeFor(caller, { name: 'koda_rule_pr_item', input: { project: 'web', jobId, itemId, text: 'confirm: test green' } });
  it('AC-4: agent tool reaches the same pending ruling and RULING comment transaction as REST', async () => {
    const j = await job(); const result = await execute(j.id);
    expect(result.isError).toBe(false);
    const ruling = await db.fleetPrRuling.findFirstOrThrow({ where: { jobId: j.id } });
    expect(ruling).toMatchObject({ state: 'pending', actorType: 'AGENT', actorId: agent.id, disposition: 'confirmed' });
    if (!ruling.commentId) throw new Error('ruling has no comment');
    expect(await db.comment.findUnique({ where: { id: ruling.commentId } })).toMatchObject({ type: 'RULING', authorAgentId: agent.id, body: 'D-1 (advisor): confirm: test green' });
    const restJob = await job();
    const rest = data<{ state: string; actorId: string; disposition: string; commentId: string }>(await request(app.getHttpServer()).post(`/api/projects/web/fleet/jobs/${restJob.id}/rulings`).set({ Authorization: `Bearer ${agent.apiKey}` }).send({ itemId: 'D-1', text: 'confirm: test green' }).expect(201));
    expect(rest).toMatchObject({ state: ruling.state, actorId: ruling.actorId, disposition: ruling.disposition });
    expect(await db.comment.findUnique({ where: { id: rest.commentId } })).toMatchObject({ type: 'RULING', authorAgentId: agent.id, body: 'D-1 (advisor): confirm: test green' });
  });
  it('policy-held ruling creates no writes before approval', async () => {
    const j = await job();
    await db.approvalPolicy.create({ data: { selector: `${world.projectId}|fleet.job.rule|type:AGENT`, projectId: world.projectId, permissionPattern: 'fleet.job.rule', principalType: 'AGENT', mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test' } });
    try {
      const result = await execute(j.id);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('pending');
      expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(0);
      expect(await db.fleetJobTicket.count({ where: { jobId: j.id } })).toBe(0);
      expect(await db.approvalRequest.findFirst({ where: { actorId: agent.id, permissionKey: 'fleet.job.rule' } })).toMatchObject({ actorId: agent.id });
    } finally {
      await db.approvalPolicy.deleteMany({ where: { projectId: world.projectId, permissionPattern: 'fleet.job.rule' } });
    }
  });
  it('AC-5: non-open item answers unknown item and creates nothing', async () => {
    const j = await job(); const result = await execute(j.id, 'D-closed');
    expect(result).toMatchObject({ isError: true }); expect(result.content).toContain('unknown item');
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(0);
    expect(await db.fleetJobTicket.count({ where: { jobId: j.id } })).toBe(0);
  });
  it('F1: an approved deferred ruling preflights outside the transaction and creates inside it', async () => {
    // Other cases in this file may leave a pending `fleet.job.rule` request behind; start from none.
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    const j = await job();
    await db.approvalPolicy.create({ data: { selector: `${world.projectId}|fleet.job.rule|type:AGENT`, projectId: world.projectId, permissionPattern: 'fleet.job.rule', principalType: 'AGENT', mode: 'human', updatedByType: 'SYSTEM', updatedById: 'test' } });
    const service = app.get(FleetPrRulingsService);
    const transactions = app.get<{ isInTransaction(): boolean }>(TRANSACTION_MANAGER);
    const original = service.preflight.bind(service);
    const active: boolean[] = [];
    const spy = vi.spyOn(service, 'preflight').mockImplementation((projectId, jobId, dto) => {
      active.push(transactions.isInTransaction());
      return original(projectId, jobId, dto);
    });
    try {
      const result = await execute(j.id);
      expect(result.content).toContain('pending');
      expect(await db.fleetPrRuling.count({ where: { jobId: j.id } })).toBe(0);
      const pending = await db.approvalRequest.findFirstOrThrow({ where: { actorId: agent.id, permissionKey: 'fleet.job.rule' } });
      const decided = data<{ status: string; result: unknown }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`)
        .set({ Authorization: `Bearer ${world.tokens.root}` }).send({ decision: 'approve' }).expect(200));
      expect(decided).toMatchObject({ status: 'executed' });
    } finally {
      spy.mockRestore();
      await db.approvalPolicy.deleteMany({ where: { projectId: world.projectId, permissionPattern: 'fleet.job.rule' } });
    }
    // Request-time preflight and the deferred one: the item-index read never runs inside the approval transaction.
    expect(active).toEqual([false, false]);
    expect(await db.fleetPrRuling.findMany({ where: { jobId: j.id } })).toEqual([
      expect.objectContaining({ state: 'pending', actorType: 'AGENT', actorId: agent.id }),
    ]);
  });
});
