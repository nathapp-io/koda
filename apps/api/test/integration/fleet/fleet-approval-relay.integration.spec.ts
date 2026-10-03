/* eslint-disable @typescript-eslint/no-non-null-assertion -- the brief's test code asserts presence with toBeDefined and then uses ! */
/**
 * Fleet S1.5 slice 2a — relay loop over HTTP: report ask -> approval -> decide -> APPROVAL_ANSWER -> ack -> delivery;
 * expiry; job-end cleanup; idempotent re-report; placement relay misfit.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-relay.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import type { ApprovalRequestEventPayload, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { ApprovalExpirySweeper } from '../../../src/fleet/approvals/approval-expiry-sweeper';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

jest.setTimeout(20_000); // idle syncs here (no commands, no acks) wait the full FLEET_SYNC_WAIT_MS

const ask = (naxAskId: string, deadlineMs = 300_000): ApprovalRequestEventPayload => ({
  naxAskId, deadlineAt: new Date(Date.now() + deadlineMs).toISOString(), command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'relay', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
});

describeIntegration('fleet approval relay (S1.5 2a, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ protocolVersion: 2, ...over })).expect(200));
  const dispatch = (body: object, expected = 201) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth(world.tokens.dev)).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body }).expect(expected);
  const approvals = async (jobId: string) =>
    data<{ records: Array<Record<string, unknown>> }>(await request(server).get(`/api/projects/web/fleet/approvals?jobId=${jobId}`).set(auth(world.tokens.dev)).expect(200)).records;
  const decide = (id: string, token: string, decision: string) =>
    request(server).post(`/api/projects/web/fleet/approvals/${id}/decide`).set(auth(token)).send({ decision });

  /**
   * One repo and one runner: placement refuses a second job on a busy repo (`busy_repo`), so every test that starts a
   * job ends it with `finish` (UPLOADING then COMPLETED, as runner-sync-lifecycle.integration.spec.ts does).
   */
  const finish = (jobId: string, leaseEpoch: number, seq: number, fromUploading = false) =>
    sync({ jobs: [{ jobId, leaseEpoch, events: [
      ...(fromUploading ? [] : [{ seq, type: 'state' as const, payload: { to: 'UPLOADING' as const } }]),
      { seq: fromUploading ? seq : seq + 1, type: 'state' as const, payload: { to: 'COMPLETED' as const } },
    ] }] });

  /** ASSIGN -> ack -> RUNNING at seq 1; returns the job id and its epoch. */
  async function startRunning(feature: string, body: object = {}): Promise<{ jobId: string; leaseEpoch: number }> {
    const jobId = data<{ job: { id: string } }>(await dispatch({ feature, bashMode: 'escalate', approvalTimeoutSec: 600, ...body })).job.id;
    const assign = (await sync({ freeSlots: 1 })).commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    if (!assign) throw new Error('no ASSIGN');
    expect(assign.payload).toEqual(expect.objectContaining({ bashMode: 'escalate', approvalTimeoutSec: 600 }));
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId, leaseEpoch: assign.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    return { jobId, leaseEpoch: assign.leaseEpoch };
  }

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '800';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'relay-1');
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('a runner without the relay: a pinned escalate dispatch is 422, an unpinned one waits QUEUED (D270)', async () => {
    await sync();   // first sync: runner online with FLEET_CAPS (no relay)
    const pinned = await dispatch({ feature: 'pinned', bashMode: 'escalate', pinnedRunnerId: runner.runnerId }, 422);
    expect(JSON.stringify(pinned.body)).toContain('approvals_relay');
    const jobId = data<{ job: { id: string } }>(await dispatch({ feature: 'waits', bashMode: 'gated' })).job.id;
    expect((await sync({ freeSlots: 1 })).commands.some((c) => c.jobId === jobId)).toBe(false);   // a free slot, still no ASSIGN
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).state).toBe('QUEUED');
    await request(server).post(`/api/projects/web/fleet/jobs/${jobId}/cancel`).set(auth(world.tokens.dev)).expect(200);
  });

  it('report ask -> pending approval -> DEVELOPER allows -> APPROVAL_ANSWER -> ack ok -> delivery', async () => {
    await sync({ capabilities: { ...FLEET_CAPS, approvals: { relay: true } } });
    const { jobId, leaseEpoch } = await startRunning('loop');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000a') }] }] });

    const [pending] = await approvals(jobId);
    expect(pending).toEqual(expect.objectContaining({ type: 'nax_bash_escalate', status: 'pending', jobId }));
    const job = data<{ pendingApprovals: number }>(await request(server).get(`/api/projects/web/fleet/jobs/${jobId}`).set(auth(world.tokens.dev)).expect(200));
    expect(job.pendingApprovals).toBe(1);

    await decide(String(pending.id), world.tokens.viewer, 'allow').expect(403);
    await decide(String(pending.id), world.tokens.dev, 'allow').expect(200);
    await decide(String(pending.id), world.tokens.dev, 'deny').expect(409);

    const answer = (await sync()).commands.find((c) => c.type === 'APPROVAL_ANSWER' && c.jobId === jobId);
    expect(answer?.payload).toEqual({ approvalId: pending.id, naxAskId: 'ask-0000000a', choice: 'allow' });
    await sync({ commandAcks: [{ commandId: answer!.commandId, leaseEpoch, result: 'ok' }] });
    const [decided] = await approvals(jobId);
    expect(decided).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow', outcome: { delivery: expect.objectContaining({ result: 'ok' }) } }));

    // Webhooks: one requested then one resolved, and neither carries the command text (A8).
    const hooks = await prisma.outboxEvent.findMany({
      where: {
        type: 'webhook_delivery',
        AND: [
          { payload: { contains: '"event":"fleet.approval.' } },
          { payload: { contains: `"jobId":"${jobId}"` } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(hooks.map((h) => h.payload)).toEqual([
      expect.stringContaining('"event":"fleet.approval.requested"'),
      expect.stringContaining('"event":"fleet.approval.resolved"'),
    ]);
    for (const h of hooks) expect(h.payload).not.toContain('bun run test');

    await finish(jobId, leaseEpoch, 3);
  });

  it('a re-reported ask (same seq, or a new seq with the same naxAskId) stays one approval', async () => {
    const { jobId, leaseEpoch } = await startRunning('idem');
    const event = { seq: 2, type: 'approval_request' as const, payload: ask('ask-0000000b') };
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ ...event, seq: 3 }] }] });
    expect(await approvals(jobId)).toHaveLength(1);
    await finish(jobId, leaseEpoch, 4);
  });

  it('an unanswered ask expires through the sweeper; a decide after it is 409 and leaves it expired', async () => {
    const { jobId, leaseEpoch } = await startRunning('expiry');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000c', 2_000) }] }] });
    const result = await app.get(ApprovalExpirySweeper).tick(new Date(Date.now() + 5_000));
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const [expired] = await approvals(jobId);
    expect(expired).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    await decide(String(expired.id), world.tokens.dev, 'allow').expect(409);
    await finish(jobId, leaseEpoch, 3);
  });

  it('an ask past its deadline on arrival is born expired', async () => {
    const { jobId, leaseEpoch } = await startRunning('late');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000d', -1_000) }] }] });
    expect((await approvals(jobId))[0]).toEqual(expect.objectContaining({ status: 'expired', resolvedBy: 'timeout' }));
    await finish(jobId, leaseEpoch, 3);
  });

  it('the job leaving RUNNING cancels its asks job_ended and withdraws an unsent answer', async () => {
    const { jobId, leaseEpoch } = await startRunning('ending');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: 2, type: 'approval_request', payload: ask('ask-0000000e') },
      { seq: 3, type: 'approval_request', payload: ask('ask-0000000f') },
    ] }] });
    const [first] = (await approvals(jobId)).filter((a) => a.status === 'pending');
    await decide(String(first.id), world.tokens.dev, 'deny').expect(200);   // answer queued, not yet synced down
    const after = await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 4, type: 'state', payload: { to: 'UPLOADING' } }] }] });
    expect(after.commands.some((c) => c.type === 'APPROVAL_ANSWER' && c.jobId === jobId)).toBe(false);
    const rows = await approvals(jobId);
    expect(rows.find((a) => a.id !== first.id)).toEqual(expect.objectContaining({ status: 'cancelled', resolvedBy: 'job_ended' }));
    await finish(jobId, leaseEpoch, 5, true);
  });

  it('a malformed ask is a rejected event, not a sync failure (D269)', async () => {
    const { jobId, leaseEpoch } = await startRunning('malformed');
    const res = await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: { ...ask('ask-00000010'), options: [] } }] }] });
    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: 2 });
    expect(await approvals(jobId)).toHaveLength(0);
    await finish(jobId, leaseEpoch, 3);
  });

  it('a v1 sync is still accepted (deploy order: server first)', async () => {
    await sync({ protocolVersion: 1 });
  });
});
