import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { grantKeys, seedWaitPolicy } from '../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../src/permissions/permission-cache';
import { FleetFlowsService } from '../../src/fleet/flows/fleet-flows.service';
import type { FleetFlowDto } from '../../src/fleet/flows/dto/fleet-flow.dto';
import { fixtureDb, withTestActor } from '../helpers/action-context';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../helpers/fleet-fixtures';
import { bootHttpApp, data, resetThrottle } from '../helpers/http-app';
import { resetDb } from '../helpers/reset-db';
import { canRunDbTests } from '../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
function refusal(response: request.Response, key: string) {
  const [namespace, ...segments] = key.split('.');
  const catalog: unknown = JSON.parse(readFileSync(join(__dirname, '../../src/i18n/en', `${namespace}.json`), 'utf8'));
  const message = segments.reduce<unknown>((node, part) => typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined, catalog);
  expect(typeof message).toBe('string');
  expect(response.body).toEqual({ ret: Number(segments.at(-1)), message });
}

describeDb('fleet flow read and stop endpoints', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let outsider: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let restricted: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let serial = 0;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    outsider = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    restricted = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: restricted.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.fleetActivity.deleteMany({ where: { entityType: 'flow' } });
    await db.auditEntry.deleteMany({ where: { key: 'fleet.flow.stop' } });
  });
  async function create(projectId = world.projectId, repoId = world.repoId) {
    return (await withTestActor({ type: 'USER', id: world.ids.dev }, () => app.get(FleetFlowsService).create({
      entry: 'NAX', repoId, branch: `feat/read-stop-${++serial}`, specSha: 'a'.repeat(40),
      features: [{ feature: 'one', specPath: 'one.md', dependsOn: [] }, { feature: 'two', specPath: 'two.md', dependsOn: ['one'] }],
      roles: { reviewer: 'reviewer', supervisor: 'supervisor' }, costCapUsd: '25.1234',
    }, { type: 'USER', id: world.ids.dev }, { projectId }))).flow;
  }
  const projectUrl = (id?: string) => `/api/projects/web/flows${id ? `/${id}` : ''}`;
  const get = (url: string, token?: string) => request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token ?? world.tokens.dev}`);
  const stop = (id: string, token?: string) => request(app.getHttpServer()).post(`${projectUrl(id)}/stop`).set('Authorization', `Bearer ${token ?? world.tokens.dev}`);

  it('AC-1: lists only this project newest first with the shared page total', async () => {
    const first = await create();
    await db.fleetFlow.update({ where: { id: first.id }, data: { createdAt: new Date('2020-01-01') } });
    const second = await create();
    await create(world.opsProjectId, world.foreignRepoId);
    const page = data<{ records: FleetFlowDto[]; total: number }>(await get(projectUrl()).expect(200));
    expect(page.total).toBe(2);
    expect(page.records.map(({ id }) => id)).toEqual([second.id, first.id]);
    const next = data<{ records: FleetFlowDto[]; total: number }>(await get(`${projectUrl()}?current=2&size=1`).expect(200));
    expect(next.total).toBe(2);
    expect(next.records.map(({ id }) => id)).toEqual([first.id]);
  });
  it('AC-2: detail maps ordered features, decimal strings and the project URL', async () => {
    const flow = await create();
    const dto = data<FleetFlowDto>(await get(projectUrl(flow.id)).expect(200));
    expect(dto.features.map(({ feature }) => feature)).toEqual(['one', 'two']);
    expect(dto).toMatchObject({ id: flow.id, costCapUsd: '25.1234', spentUsd: '0.0000', url: `/web/flows/${flow.id}`, roles: { reviewer: 'reviewer', supervisor: 'supervisor' } });
  });
  it('AC-3: project detail hides a flow in another project', async () => {
    const foreign = await create(world.opsProjectId, world.foreignRepoId);
    refusal(await get(projectUrl(foreign.id)).expect(404), 'fleet.flows.notFound.404');
  });
  it('AC-4: rostered agent sees the identical DTO at both URLs', async () => {
    const flow = await create();
    const project = await get(projectUrl(flow.id), agent.apiKey).expect(200);
    const global = await get(`/api/fleet/flows/${flow.id}`, agent.apiKey).expect(200);
    expect(global.body).toEqual(project.body);
  });
  it('AC-5: global detail hides the project from an unrostered agent', async () => {
    const flow = await create();
    refusal(await get(`/api/fleet/flows/${flow.id}`, outsider.apiKey).expect(404), 'fleet.flows.notFound.404');
  });
  it('AC-6: project reach without fleet.flow.read is 403', async () => {
    await create();
    await get(projectUrl(), restricted.apiKey).expect(403);
  });
  it('AC-7/8/11: stops PENDING, closes its start ask, audits and records activity atomically', async () => {
    const flow = await create();
    const dto = data<FleetFlowDto>(await stop(flow.id).expect(200));
    expect(dto).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop' });
    expect(dto.endedAt).toEqual(expect.any(String));
    if (!dto.endedAt || !flow.approvalRequestId) throw new Error('missing stop timestamp or start ask');
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop', endedAt: new Date(dto.endedAt) });
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: flow.approvalRequestId } })).toMatchObject({ status: 'cancelled', result: { closedBy: 'flow_stopped' } });
    expect(await db.auditEntry.findFirstOrThrow({ where: { key: 'fleet.flow.stop', resourceId: flow.id } })).toMatchObject({ resourceType: 'flow', projectId: world.projectId });
    expect(await db.fleetActivity.findFirstOrThrow({ where: { action: 'flow.stopped', entityId: flow.id } })).toMatchObject({ projectId: world.projectId, payload: { flowId: flow.id, stopReason: 'human_stop' } });
  });
  it('AC-9: stops an APPROVED flow', async () => {
    const flow = await create();
    await request(app.getHttpServer()).post(`/api/approvals/${flow.approvalRequestId}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
    expect(data<FleetFlowDto>(await stop(flow.id).expect(200)).state).toBe('STOPPED');
  });
  it.each(['STOPPED', 'COMPLETED'] as const)('AC-10/14: rejects terminal %s without changing it', async (state) => {
    const flow = await create();
    await db.fleetFlow.update({ where: { id: flow.id }, data: { state } });
    refusal(await stop(flow.id).expect(409), 'fleet.flows.notStoppable.409');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe(state);
    expect(await db.auditEntry.count({ where: { key: 'fleet.flow.stop' } })).toBe(0);
  });
  it('AC-12: no stop key means 403 and no mutation', async () => {
    const flow = await create();
    await stop(flow.id, world.tokens.viewer).expect(403);
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('PENDING');
    if (!flow.approvalRequestId) throw new Error('missing start ask');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: flow.approvalRequestId } })).status).toBe('pending');
  });
  it('AC-13: agent policy returns 202 without mutation; approval runs the registered stop', async () => {
    const flow = await create();
    const policy = await seedWaitPolicy(db, 'fleet.flow.stop', world.projectId);
    try {
      const ask = data<{ id: string; permissionKey: string }>(await stop(flow.id, agent.apiKey).expect(202));
      expect(ask.permissionKey).toBe('fleet.flow.stop');
      expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('PENDING');
      expect(await db.auditEntry.count({ where: { key: 'fleet.flow.stop' } })).toBe(0);
      await request(app.getHttpServer()).post(`/api/approvals/${ask.id}/decisions`).set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
      expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop' });
    } finally { await db.approvalPolicy.delete({ where: { id: policy.id } }); }
  });
  it('stops a thread flow even after its thread is archived and no longer eligible to create', async () => {
    const flow = await create();
    const thread = await db.chatThread.create({ data: { projectId: world.projectId, repoId: world.repoId, kind: 'REPO',
      feature: `archived-${++serial}`, baseRef: 'main', title: 'Archived flow parent', createdById: world.ids.dev,
      backend: { kind: 'native', model: 'model' }, skills: [], status: 'ARCHIVED', specPublished: false, runnerId: null } });
    await db.fleetFlow.update({ where: { id: flow.id }, data: { entry: 'THREAD', threadId: thread.id } });
    expect(data<FleetFlowDto>(await stop(flow.id, agent.apiKey).expect(200))).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop' });
  });
  it('a skipped ask close is not fatal and a late start approval cannot revive the stopped flow', async () => {
    const { ApprovalAskService } = await import('../../src/approvals/approval-ask.service');
    const flow = await create();
    // Model the close outcome when a decider already holds the request's row lock.
    const close = vi.spyOn(app.get(ApprovalAskService), 'close').mockResolvedValue(null);
    try { await stop(flow.id).expect(200); } finally { close.mockRestore(); }
    const response = await request(app.getHttpServer()).post(`/api/approvals/${flow.approvalRequestId}/decisions`)
      .set('Authorization', `Bearer ${world.tokens.root}`).send({ decision: 'approve' }).expect(200);
    expect(data<{ status: string }>(response).status).toBe('executed');
    if (!flow.approvalRequestId) throw new Error('missing start ask');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: flow.approvalRequestId } })).result).toMatchObject({ applied: false });
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('STOPPED');
  });
  it('rolls back state, ask closure and audit if activity recording fails', async () => {
    const { FleetActivityService } = await import('../../src/fleet/activity/fleet-activity.service');
    const flow = await create();
    const activity = vi.spyOn(app.get(FleetActivityService), 'record').mockRejectedValue(new Error('injected activity failure'));
    try {
      await stop(flow.id).expect(500);
      expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).state).toBe('PENDING');
      if (!flow.approvalRequestId) throw new Error('missing start ask');
      expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: flow.approvalRequestId } })).status).toBe('pending');
      expect(await db.auditEntry.count({ where: { key: 'fleet.flow.stop', resourceId: flow.id } })).toBe(0);
    } finally { activity.mockRestore(); }
  });
  it('AC-15: missing IDs and cross-project stop are all the same 404', async () => {
    refusal(await get(projectUrl('missing')).expect(404), 'fleet.flows.notFound.404');
    refusal(await get('/api/fleet/flows/missing', agent.apiKey).expect(404), 'fleet.flows.notFound.404');
    refusal(await stop('missing').expect(404), 'fleet.flows.notFound.404');
    const foreign = await create(world.opsProjectId, world.foreignRepoId);
    refusal(await stop(foreign.id).expect(404), 'fleet.flows.notFound.404');
    expect((await db.fleetFlow.findUniqueOrThrow({ where: { id: foreign.id } })).state).toBe('PENDING');
  });
});
