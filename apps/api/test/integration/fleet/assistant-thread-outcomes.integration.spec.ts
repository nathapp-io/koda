import { pendingRequestId } from '../../helpers/assistant-request';
import type { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

integration('assistant thread request outcomes through relay and expiry (PG, US-008)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let ticketNumber = 1;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const decide = (id: string, decision: 'approve' | 'reject') => request(app.getHttpServer())
    .post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.dev)).send({ decision });
  const messages = (threadId: string) => db.chatMessage.findMany({ where: { threadId, role: 'system' }, orderBy: { seq: 'asc' } });

  async function open(tool = 'koda_add_comment', input?: unknown) {
    if (input === undefined && tool === 'koda_add_comment') {
      ticketNumber += 1;
      await db.ticket.create({ data: { projectId: world.projectId, number: ticketNumber, title: `Outcome ${ticketNumber}`, type: 'BUG', status: 'CREATED', priority: 'HIGH' } });
      input = { ref: `WEB-${ticketNumber}`, body: `comment-${ticketNumber}` };
    }
    const seed = await seedThreadJobFor(db, world, runner, { feature: `outcome-${++seq}` });
    const response = data<{ content: string; isError: boolean }>(await request(app.getHttpServer())
      .post(`/api/fleet/runner/jobs/${seed.jobId}/tools/${tool}?leaseEpoch=1`).set(auth(runner.apiKey))
      .send({ toolCallId: `outcome-${seq}`, input }).expect(200));
    expect(response.isError).toBe(false);
    return { id: pendingRequestId(response.content), threadId: seed.threadId };
  }
  async function relay() { await app.get(OutboxRelay, { strict: false }).dispatchPendingBatch(); }

  beforeAll(async () => {
    for (const key of ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED'] as const) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true'; process.env.FLEET_SWEEP_ENABLED = 'false';
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'thread-outcomes-runner');
    await db.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() } });
    await db.ticket.create({ data: { projectId: world.projectId, number: 1, title: 'Outcome target', type: 'BUG', status: 'CREATED', priority: 'HIGH' } });
  }, 120_000);
  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const key of ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED'] as const) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });

  it('AC-1: approved comment emits its completed note after relay', async () => {
    const { id, threadId } = await open();
    await decide(id, 'approve').expect(200);
    expect(await messages(threadId)).toHaveLength(0);
    const comment = await db.comment.findFirstOrThrow({ where: { ticket: { projectId: world.projectId } }, orderBy: { createdAt: 'desc' } });
    await relay();
    const ticket = await db.ticket.findUniqueOrThrow({ where: { id: comment.ticketId } });
    const ref = `WEB-${ticket.number}`;
    expect((await messages(threadId)).map((m) => m.content)).toEqual([`Action ${id} (koda_add_comment) was approved and done: comment ${comment.id} added to ${ref} /web/tickets/${ref}`]);
  });

  it('AC-2: rejected request emits one rejection note after relay', async () => {
    const { id, threadId } = await open(); await decide(id, 'reject').expect(200); await relay();
    expect((await messages(threadId)).map((m) => m.content)).toEqual([`Action ${id} (koda_add_comment) was rejected.`]);
  });

  it('AC-3,4: deleted comment target fails approval and emits not_found note', async () => {
    const { id, threadId } = await open();
    await db.ticket.update({ where: { projectId_number: { projectId: world.projectId, number: ticketNumber } }, data: { deletedAt: new Date() } });
    await decide(id, 'approve').expect(200);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: 'NotFoundAppException' } });
    await relay();
    expect((await messages(threadId)).map((m) => m.content)).toEqual([`Action ${id} (koda_add_comment) was approved but failed: not_found`]);
  });

  it('AC-5,6: failed link batch rolls back the earlier link', async () => {
    const first = await db.ticket.create({ data: { projectId: world.projectId, number: 100, title: 'SB-1', type: 'BUG', status: 'CREATED', priority: 'HIGH' } });
    const second = await db.ticket.create({ data: { projectId: world.projectId, number: 101, title: 'SB-2', type: 'BUG', status: 'CREATED', priority: 'HIGH' } });
    const { id } = await open('koda_link_tickets', { links: [{ ref: 'WEB-100', url: 'https://example.com/1' }, { ref: 'WEB-101', url: 'https://example.com/2' }] });
    await db.ticket.update({ where: { id: second.id }, data: { deletedAt: new Date() } });
    await decide(id, 'approve').expect(200);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await db.ticketLink.count({ where: { ticketId: first.id } })).toBe(0);
  });

  it('AC-7,8: expiry sweeper settles due request and relay emits expiry note', async () => {
    const { id, threadId } = await open();
    await db.approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await app.get(ApprovalRequestExpirySweeper, { strict: false }).tick(new Date());
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'expired' });
    await relay();
    expect((await messages(threadId)).map((m) => m.content)).toEqual([`Action ${id} (koda_add_comment) expired without a decision.`]);
  });
});
