import { pendingRequestId } from '../../helpers/assistant-request';
import type { NathApplication } from '@nathapp/nestjs-app';
import request from 'supertest';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';
import { MembershipService } from '../../../src/permissions/membership.service';
import { grantRole, revokeProjectRoles } from '../../../src/permissions/test-helpers/permission-fixtures';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import type { PrismaClient } from '../../../src/generated/prisma/client';

const integration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

interface RequestSummary { id: string; status: string; approverId: string | null }

integration('deciding assistant thread requests through approvals API (PG, US-007)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let ticketNumber = 0;
  let threadSeq = 0;
  const savedThreadsEnabled = process.env.FLEET_THREADS_ENABLED;

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const decide = (id: string, token: string, decision: 'approve' | 'reject') => request(app.getHttpServer())
    .post(`/api/approvals/${id}/decisions`).set(as(token)).send({ decision });
  const record = (id: string) => db.approvalRequest.findUniqueOrThrow({ where: { id } });
  const comments = (ticketId: string) => db.comment.findMany({ where: { ticketId } });

  async function openRequest(): Promise<{ id: string; ticketId: string }> {
    const num = ++ticketNumber;
    const ticket = await db.ticket.create({
      data: { projectId: world.projectId, number: num, title: `Thread decision ${num}`, type: 'BUG', status: 'CREATED', priority: 'HIGH' },
    });
    const seed = await seedThreadJobFor(db, world, runner, { feature: `decide-thread-${++threadSeq}` });
    const response = data<{ content: string; isError: boolean }>(await request(app.getHttpServer())
      .post(`/api/fleet/runner/jobs/${seed.jobId}/tools/koda_add_comment?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runner.apiKey}` }).send({ toolCallId: `decide-${threadSeq}`, input: { ref: `WEB-${num}`, body: 'approved comment' } }).expect(200));
    expect(response.isError).toBe(false);
    return { id: pendingRequestId(response.content), ticketId: ticket.id };
  }

  beforeAll(async () => {
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'thread-decide-runner');
    await db.runner.update({ where: { id: runner.runnerId }, data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date() } });

    const admin = { type: 'USER' as const, id: world.ids.viewer };
    await revokeProjectRoles(db, admin, world.projectId);
    await grantRole(db, admin, 'project-admin', world.projectId);
    // A separate principal with only the decide key exercises approverMustHoldAction.
    await grantKeys(db, { type: 'USER', id: world.ids.outsider }, ['approval.decide'], world.projectId);
    await app.get(MembershipService).invalidatePermissions();
  }, 120_000);

  afterAll(async () => {
    try { await app?.close(); }
    finally {
      if (savedThreadsEnabled === undefined) delete process.env.FLEET_THREADS_ENABLED;
      else process.env.FLEET_THREADS_ENABLED = savedThreadsEnabled;
    }
  });

  it('AC-3/AC-4: requester approval executes the write as the requester', async () => {
    const { id, ticketId } = await openRequest();
    await decide(id, world.tokens.dev, 'approve').expect(200);
    expect(await comments(ticketId)).toMatchObject([{ body: 'approved comment', authorUserId: world.ids.dev, authorAgentId: null }]);
    expect(await record(id)).toMatchObject({ status: 'executed', approverType: 'USER', approverId: world.ids.dev });
  });

  it('AC-5/AC-6: requester rejection leaves the target unchanged and records rejected', async () => {
    const { id, ticketId } = await openRequest();
    await decide(id, world.tokens.dev, 'reject').expect(200);
    expect(await comments(ticketId)).toEqual([]);
    expect(await record(id)).toMatchObject({ status: 'rejected' });
  });

  it('AC-7/AC-8: requester without the action permission is refused and request remains pending', async () => {
    const { id, ticketId } = await openRequest();
    await revokeProjectRoles(db, { type: 'USER', id: world.ids.dev }, world.projectId);
    await app.get(MembershipService).invalidatePermissions();
    try {
      const response = await decide(id, world.tokens.dev, 'approve').expect(403);
      expect(response.body.message).toContain('missing-action-permission');
      expect(await record(id)).toMatchObject({ status: 'pending', approverId: null });
      expect(await comments(ticketId)).toEqual([]);
    } finally {
      await grantRole(db, { type: 'USER', id: world.ids.dev }, 'developer', world.projectId);
      await app.get(MembershipService).invalidatePermissions();
    }
  });

  it('AC-9/AC-10: non-requester Project Admin approves and is recorded as approver', async () => {
    const { id, ticketId } = await openRequest();
    await decide(id, world.tokens.viewer, 'approve').expect(200);
    expect(await record(id)).toMatchObject({ status: 'executed', approverType: 'USER', approverId: world.ids.viewer });
    expect(await comments(ticketId)).toMatchObject([{ body: 'approved comment', authorUserId: world.ids.dev, authorAgentId: null }]);
  });

  it('AC-11: decide-only principal lacks the action permission and cannot decide', async () => {
    const { id, ticketId } = await openRequest();
    const response = await decide(id, world.tokens.outsider, 'approve').expect(403);
    expect(response.body.message).toContain('missing-action-permission');
    expect(await record(id)).toMatchObject({ status: 'pending', approverId: null });
    expect(await comments(ticketId)).toEqual([]);
  });
});
