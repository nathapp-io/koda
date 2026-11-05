import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { Prisma } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { FLEET_CAPS, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('PATCH thread mode between turns', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let own: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let n = 0;
  const path = '/api/projects/web/threads';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const patch = (id: string, mode: string, token = world.tokens.dev) => request(app.getHttpServer()).patch(`${path}/${id}/mode`).set(auth(token)).send({ mode });
  const make = async (createdById = world.ids.dev, createdByType = 'USER', mode = 'read') => db.chatThread.create({ data: { kind: 'REPO', projectId: world.projectId, repoId: world.repoId, baseRef: 'main', feature: `change-mode-${++n}`, specPath: 'spec.md', title: 'Mode change', backend: { kind: 'native', model: 'm1' }, skills: [], createdById, createdByType, mode } });
  const reload = (id: string) => db.chatThread.findUniqueOrThrow({ where: { id } });
  const live = async (threadId: string, state = 'RUNNING', action = 'SESSION') => {
    const runner = await db.runner.create({ data: { name: `mode-runner-${++n}`, apiKeyHash: `mode-hash-${n}`, os: 'linux', arch: 'x64', labels: [], capacity: 2, capabilities: { ...FLEET_CAPS, threadWrite: true, threadModes: true } as unknown as Prisma.InputJsonValue, daemonVersion: '0.1.0', protocolVersion: 4, bootId: `boot-${n}`, enabled: true, lastSeenAt: new Date(), createdById: world.ids.root } });
    await db.chatThread.update({ where: { id: threadId }, data: { runnerId: runner.id } });
    const job = await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'THREAD', feature: `thread-${threadId}`, profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER', threadId, runnerId: runner.id, state, leaseEpoch: 7 } });
    await db.fleetThreadTurn.create({ data: { jobId: job.id, threadId, action, instructions: '', backend: { kind: 'native', model: 'm1' }, skills: [], resume: false } });
    return job;
  };
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app); world = await seedFleetHttpWorld(app.getHttpServer(), db);
    app.get<IFleetConfig>(FLEET_CFG).threadsEnabled = true;
    await grantRole(db, { type: 'USER', id: world.ids.viewer }, 'project-admin', world.projectId);
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    own = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'thread.mode.ask'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: own.id }, ['project.read', 'thread.cap.update.own'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(() => resetThrottle(app));
  afterEach(() => vi.restoreAllMocks());

  it('AC-1: creator developer stores ask and a complete current-name system message', async () => {
    const row = await make();
    const user = await db.user.findUniqueOrThrow({ where: { id: world.ids.dev } });
    expect(data(await patch(row.id, 'ask').expect(200))).toMatchObject({ mode: 'ask' });
    expect((await reload(row.id)).mode).toBe('ask');
    expect(await db.chatMessage.findMany({ where: { threadId: row.id } })).toEqual([expect.objectContaining({ role: 'system', status: 'complete', content: `Mode changed from read to ask by ${user.name}` })]);
  });
  it('AC-2: developer creator cannot use full', async () => {
    const row = await make(); await patch(row.id, 'full').expect(403);
    expect((await reload(row.id)).mode).toBe('read');
  });
  it('AC-3: noncreator project admin can use full', async () => {
    const row = await make(); await patch(row.id, 'full', world.tokens.viewer).expect(200);
    expect((await reload(row.id)).mode).toBe('full');
  });
  it('AC-4: noncreator developer cannot use ask', async () => {
    const row = await make(world.ids.viewer); await patch(row.id, 'ask').expect(403);
    expect((await reload(row.id)).mode).toBe('read');
  });
  it('AC-5: creator with only cap.update.own returns to read', async () => {
    const row = await make(own.id, 'AGENT', 'ask'); await patch(row.id, 'read', own.apiKey).expect(200);
    expect((await reload(row.id)).mode).toBe('read');
  });
  it.each(['QUEUED', 'ASSIGNED'])('AC-6: %s session refuses turnRunning', async state => {
    const row = await make(); await live(row.id, state);
    const res = await patch(row.id, 'ask').expect(409); expect(JSON.stringify(res.body)).toContain('turn');
    expect((await reload(row.id)).mode).toBe('read');
  });
  it('AC-7: running turn refuses turnRunning', async () => {
    const row = await make(); await live(row.id);
    await db.chatMessage.create({ data: { threadId: row.id, seq: 1, role: 'assistant', status: 'streaming', content: 'Working' } });
    const res = await patch(row.id, 'ask').expect(409); expect(JSON.stringify(res.body)).toContain('turn');
    expect((await reload(row.id)).mode).toBe('read');
  });
  it.each(['PUBLISH', 'DISCARD'])('AC-8: active %s refuses busy', async action => {
    const row = await make(); await live(row.id, 'RUNNING', action);
    const res = await patch(row.id, 'ask').expect(409); expect(JSON.stringify(res.body)).toContain('active');
    expect((await reload(row.id)).mode).toBe('read');
  });
  it('AC-9: idle session changes mode and closes exactly once', async () => {
    const row = await make(); const job = await live(row.id);
    await patch(row.id, 'ask').expect(200);
    expect((await reload(row.id)).mode).toBe('ask');
    expect(await db.fleetCommand.findMany({ where: { jobId: job.id } })).toEqual([expect.objectContaining({ type: 'THREAD_CLOSE', leaseEpoch: 7 })]);
  });
  it('AC-10: already closing session does not get another command', async () => {
    const row = await make(); const job = await live(row.id);
    if (!job.runnerId) throw new Error('Missing test runner');
    await db.fleetCommand.create({ data: { runnerId: job.runnerId, jobId: job.id, type: 'THREAD_CLOSE', leaseEpoch: 7, payload: {} } });
    await patch(row.id, 'ask').expect(200);
    expect((await reload(row.id)).mode).toBe('ask');
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_CLOSE' } })).toBe(1);
  });
  it('AC-11: no-op has no message and no command', async () => {
    const row = await make(); const job = await live(row.id);
    await patch(row.id, 'read').expect(200);
    expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(0);
    expect(await db.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  });
  it('AC-12: agent with ask but no policy waits until approval then writes once', async () => {
    const row = await make(agent.id, 'AGENT');
    const pending = data<{ id: string; permissionKey: string }>(await patch(row.id, 'ask', agent.apiKey).expect(202));
    expect(pending.permissionKey).toBe('thread.mode.ask'); expect((await reload(row.id)).mode).toBe('read');
    expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(0);
    const result = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
    expect(result.status).toBe('executed'); expect((await reload(row.id)).mode).toBe('ask');
    expect(await db.chatMessage.count({ where: { threadId: row.id, role: 'system' } })).toBe(1);
  });
  it('replay resolves the agent name when writing, not when approval was opened', async () => {
    const row = await make(agent.id, 'AGENT');
    const pending = data<{ id: string }>(await patch(row.id, 'ask', agent.apiKey).expect(202));
    const before = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    try {
      await db.agent.update({ where: { id: agent.id }, data: { name: 'Renamed agent' } });
      const result = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
      expect(result.status).toBe('executed');
      expect(await db.chatMessage.findFirst({ where: { threadId: row.id } })).toMatchObject({ content: 'Mode changed from read to ask by Renamed agent' });
    } finally { await db.agent.update({ where: { id: agent.id }, data: { name: before.name } }); }
  });
  it('replay rechecks creator authority instead of inheriting the approver authority', async () => {
    const row = await make(agent.id, 'AGENT');
    const pending = data<{ id: string }>(await patch(row.id, 'ask', agent.apiKey).expect(202));
    await db.chatThread.update({ where: { id: row.id }, data: { createdById: world.ids.dev, createdByType: 'USER' } });
    const result = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
    expect(result.status).toBe('failed'); expect((await reload(row.id)).mode).toBe('read');
    expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(0);
  });
  it('replay fails without writes after the target mode key is revoked', async () => {
    const row = await make(agent.id, 'AGENT');
    const pending = data<{ id: string }>(await patch(row.id, 'ask', agent.apiKey).expect(202));
    const bindings = await db.roleBinding.findMany({ where: { principalId: agent.id, projectId: world.projectId } });
    const roles = await db.role.findMany({ where: { id: { in: bindings.map(b => b.roleId) } } });
    try {
      for (const role of roles) await db.role.update({ where: { id: role.id }, data: { permissions: ['project.read'] } });
      await app.get(PermissionCache).invalidate();
      const result = data<{ status: string }>(await request(app.getHttpServer()).post(`/api/approvals/${pending.id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
      expect(result.status).toBe('failed'); expect((await reload(row.id)).mode).toBe('read');
      expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(0);
    } finally {
      for (const role of roles) await db.role.update({ where: { id: role.id }, data: { permissions: role.permissions ?? [] } });
      await app.get(PermissionCache).invalidate();
    }
  });
  it('concurrent identical changes serialize to one message and one close', async () => {
    const row = await make(); const job = await live(row.id);
    await Promise.all([patch(row.id, 'ask').expect(200), patch(row.id, 'ask').expect(200)]);
    expect((await reload(row.id)).mode).toBe('ask');
    expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(1);
    expect(await db.fleetCommand.count({ where: { jobId: job.id, type: 'THREAD_CLOSE' } })).toBe(1);
  });
  it('AC-13: audit is under the target mode key and names both modes', async () => {
    const row = await make(); await patch(row.id, 'ask').expect(200);
    expect(await db.auditEntry.findFirst({ where: { resourceId: row.id, key: 'thread.mode.ask' } })).toMatchObject({ summary: expect.stringContaining('read to ask') });
  });
  it('AC-14: bogus mode is a 400 naming mode', async () => {
    const row = await make(); const res = await patch(row.id, 'bogus').expect(400);
    expect(JSON.stringify(res.body)).toContain('mode'); expect((await reload(row.id)).mode).toBe('read');
  });
  it('audit failure rolls back mode, system message and close command together', async () => {
    const row = await make(); const job = await live(row.id);
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit failure'));
    await patch(row.id, 'ask').expect(500);
    expect((await reload(row.id)).mode).toBe('read');
    expect(await db.chatMessage.count({ where: { threadId: row.id } })).toBe(0);
    expect(await db.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  });
});
