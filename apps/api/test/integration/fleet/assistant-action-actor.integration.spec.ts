import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaPendingActionRepository } from '../../../src/fleet/assistant/actions/prisma-pending-action.repository';
import { PrismaAssistantToolCallRepository } from '../../../src/fleet/assistant/prisma-assistant-tool-call.repository';
import { PendingActionExpirySweeper } from '../../../src/fleet/assistant/actions/pending-action-expiry.sweeper';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';

const integration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

integration('assistant action actors (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let actions: PrismaPendingActionRepository;
  let calls: PrismaAssistantToolCallRepository;
  let seq = 0;
  const env = ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of env) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true';
    process.env.FLEET_SWEEP_ENABLED = 'false';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'actor-runner', {
      capabilities: { ...FLEET_CAPS, kodaTools: true, threadBackends: { native: ['m1'], acp: [] }, threadWrite: true },
    });
    actions = app.get(PrismaPendingActionRepository, { strict: false });
    calls = app.get(PrismaAssistantToolCallRepository, { strict: false });
    await db.ticket.create({ data: { projectId: world.projectId, number: 1, title: 'Actor ticket', type: 'BUG', status: 'CREATED', priority: 'HIGH', createdByUserId: world.ids.dev } });
  }, 120_000);
  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const key of env) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  const direct = () => db.pendingAction.create({ data: {
    projectId: world.projectId, threadId: null, jobId: null, toolCallId: null, requestedById: null,
    actorType: 'agent', actorId: 'agent-1', origin: 'mcp', approvalMode: 'none',
    tool: 'koda_add_comment', input: {}, preview: 'direct', status: 'EXECUTED', result: 'ok',
    decidedAt: new Date(), expiresAt: new Date(),
  } });

  async function propose() {
    const seed = await seedThreadJobFor(db, world, runner, { feature: `actor-${++seq}` });
    await request(app.getHttpServer()).post(`/api/fleet/runner/jobs/${seed.jobId}/tools/koda_add_comment?leaseEpoch=1`)
      .set('Authorization', `Bearer ${runner.apiKey}`).send({ toolCallId: `actor-${seq}`, input: { ref: 'WEB-1', body: 'x' } }).expect(200);
    return db.pendingAction.findFirstOrThrow({ where: { jobId: seed.jobId } });
  }
  async function decide(id: string, decision: string) {
    await request(app.getHttpServer()).post(`/api/projects/web/fleet/approvals/${id}/decide`)
      .set('Authorization', `Bearer ${world.tokens.dev}`).send({ decision }).expect(200);
  }

  it('AC-7: permits an agent direct action with null thread fields', async () => {
    expect(await direct()).toMatchObject({ actorType: 'agent', threadId: null, jobId: null, toolCallId: null, requestedById: null });
  });
  it('AC-8: permits multiple agent audit rows with null replay and project fields', async () => {
    for (let i = 0; i < 2; i++) {
      const row = await db.assistantToolCall.create({ data: {
        jobId: null, threadId: null, toolCallId: null, projectId: null, actorType: 'agent', actorId: 'agent-1',
        tool: 'koda_my_projects', inputHash: 'hash', outcome: 'ok', content: 'ok', isError: false, resultBytes: 2, durationMs: 0,
      } });
      expect(row).toMatchObject({ actorType: 'agent', projectId: null });
    }
  });
  it('AC-9: runner proposal derives thread actor and approval mode', async () => {
    const row = await propose();
    expect(row).toMatchObject({ actorType: 'user', actorId: world.ids.dev, origin: 'thread', approvalMode: 'human' });
    expect(await actions.findById(row.id)).toMatchObject({ actorType: 'user', actorId: world.ids.dev, origin: 'thread', approvalMode: 'human', approverType: null, approverId: null });
  });
  it('AC-10: runner audit records the thread creator', async () => {
    const row = await propose();
    expect(await calls.findByCall(row.jobId as string, row.toolCallId as string)).toMatchObject({ actorType: 'user', actorId: world.ids.dev });
  });
  it.each([['AC-11', 'approve', 'EXECUTED'], ['AC-12', 'reject', 'REJECTED']])('%s: records the human approver on %s', async (_ac, decision, status) => {
    const row = await propose();
    await decide(row.approvalId as string, decision);
    expect(await actions.findById(row.id)).toMatchObject({ status, approverType: 'user', approverId: world.ids.dev, decidedById: world.ids.dev });
  });
  it('AC-13: sweeper expiry has no approver', async () => {
    const row = await propose();
    await db.pendingAction.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
    expect(await app.get(PendingActionExpirySweeper, { strict: false }).tick()).toMatchObject({ failed: 0 });
    expect(await actions.findById(row.id)).toMatchObject({ status: 'EXPIRED', approverType: null, approverId: null });
  });
  it('AC-14: finds user identity including disabled, or null', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: world.ids.dev } });
    expect(await calls.findUserActor(user.id)).toEqual({ id: user.id, email: user.email, role: user.role, disabled: user.disabled });
    expect(await calls.findUserActor('missing-user')).toBeNull();
  });
  it('AC-15: actor status reads are scoped by actor type, id and project', async () => {
    const row = await direct();
    expect(await actions.findScopedByActor(row.id, world.projectId, { type: 'agent', id: 'agent-1' })).toEqual({
      id: row.id, tool: row.tool, status: row.status, createdAt: row.createdAt, decidedAt: row.decidedAt, result: row.result,
    });
    expect(await actions.findScopedByActor(row.id, world.projectId, { type: 'agent', id: 'agent-2' })).toBeNull();
    expect(await actions.findScopedByActor(row.id, world.projectId, { type: 'user', id: 'agent-1' })).toBeNull();
    expect(await actions.findScopedByActor(row.id, 'other-project', { type: 'agent', id: 'agent-1' })).toBeNull();
  });
  it('thread reads and writes exclude direct actions', async () => {
    const row = await direct();
    expect(await actions.findById(row.id)).toBeNull();
    expect(await actions.lockById(row.id)).toBeNull();
    await expect(actions.resolve(row.id, { status: 'FAILED', decidedAt: new Date() })).rejects.toThrow();
    expect((await db.pendingAction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('EXECUTED');
    await db.pendingAction.update({ where: { id: row.id }, data: { status: 'PENDING', expiresAt: new Date(0) } });
    expect((await actions.findDue(new Date(), 100)).map((a) => a.id)).not.toContain(row.id);
  });
  it('fails closed on malformed thread-origin rows with null thread fields', async () => {
    const row = await direct();
    await db.pendingAction.update({ where: { id: row.id }, data: { origin: 'thread' } });
    await expect(actions.findById(row.id)).rejects.toThrow();
  });
});
