import { canRunDbTests } from '../../helpers/test-environment';
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the brief's test code asserts presence with toBeDefined and then uses ! */
/**
 * Fleet S1.5 slice 2a — relay loop over HTTP: report ask -> approval -> decide -> APPROVAL_ANSWER -> ack -> delivery;
 * expiry; job-end cleanup; idempotent re-report; placement relay misfit.
 *
 * Permissions P3 US-006: the ask is an `ApprovalRequest` with a `FleetApprovalAsk` link, so the relay assertions read
 * those two tables and a decide goes through the engine route (`POST /api/approvals/:id/decisions`). The fleet decide
 * adapter and the delivery recorder are US-010/US-008.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-relay.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import type { ApprovalRequestEventPayload, SyncRequest, SyncResponse } from '@nathapp/fleet-protocol';
import { ApprovalPolicyService } from '../../../src/approvals/approval-policy.service';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { MAX_ASKS_CLOSED_PER_CALL } from '../../../src/fleet/approvals/approval-closer';
import { ApprovalJobEndSweeper } from '../../../src/fleet/approvals/approval-job-end.sweeper';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 20_000 }); // idle syncs here (no commands, no acks) wait the full FLEET_SYNC_WAIT_MS

const ask = (naxAskId: string, deadlineMs = 300_000, over: Partial<ApprovalRequestEventPayload> = {}): ApprovalRequestEventPayload => ({
  naxAskId, deadlineAt: new Date(Date.now() + deadlineMs).toISOString(), command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'relay', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'], ...over,
});

describeIntegration('fleet approval relay (S1.5 2a, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let runner: { runnerId: string; apiKey: string };
  const saved = process.env.FLEET_SYNC_WAIT_MS;
  let relayEnabled = false;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync').set(auth(runner.apiKey)).send(syncBody({ protocolVersion: 2, ...over })).expect(200));
  /** The relay capability is what lets a runner hold an escalated job; one sync turns it on for the rest of the file. */
  const enableRelay = async (): Promise<void> => {
    if (relayEnabled) return;
    await sync({ capabilities: { ...FLEET_CAPS, approvals: { relay: true } } });
    relayEnabled = true;
  };
  const dispatch = (body: object, expected = 201) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth(world.tokens.dev)).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body }).expect(expected);

  /** The ask links of a job, oldest request first. */
  const linksOf = (jobId: string) =>
    prisma.fleetApprovalAsk.findMany({ where: { jobId }, orderBy: [{ createdAt: 'asc' }, { requestId: 'asc' }] });
  const requestsOf = async (jobId: string) =>
    Promise.all((await linksOf(jobId)).map((link) => prisma.approvalRequest.findUniqueOrThrow({ where: { id: link.requestId } })));
  const requestOf = (id: string) => prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  /** The engine's decide route: a developer holds `approval.decide@fleet.job.shell.escalate` in `web`. */
  const decide = (id: string, token: string, body: object = { decision: 'approve' }) =>
    request(server).post(`/api/approvals/${id}/decisions`).set(auth(token)).send(body);
  /** The fleet activity rows of one job, optionally only one action. */
  const activity = (jobId: string, action?: string) =>
    prisma.fleetActivity.findMany({ where: { jobId, ...(action === undefined ? {} : { action }) }, orderBy: { createdAt: 'asc' } });
  /** The `runner.sync` audit entries of one resource, optionally only those whose summary starts with a prefix. */
  const auditRows = (resourceId: string, summaryStartsWith?: string) =>
    prisma.auditEntry.findMany({
      where: { resourceId, key: 'runner.sync', ...(summaryStartsWith === undefined ? {} : { summary: { startsWith: summaryStartsWith } }) },
      orderBy: { createdAt: 'asc' },
    });

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
  async function startRunning(
    feature: string,
    body: { bashMode?: string; approvalTimeoutSec?: number } = {},
  ): Promise<{ jobId: string; leaseEpoch: number }> {
    const bashMode = body.bashMode ?? 'escalate';
    const approvalTimeoutSec = body.approvalTimeoutSec ?? 600;
    const jobId = data<{ job: { id: string } }>(await dispatch({ feature, bashMode, approvalTimeoutSec })).job.id;
    const assign = (await sync({ freeSlots: 1 })).commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    if (!assign) throw new Error(`no ASSIGN for ${feature}`);
    expect(assign.payload).toEqual(expect.objectContaining({ bashMode, approvalTimeoutSec }));
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: assign.leaseEpoch, result: 'ok' }],
      jobs: [{ jobId, leaseEpoch: assign.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    return { jobId, leaseEpoch: assign.leaseEpoch };
  }

  /** A project policy that resolves `fleet.job.shell.escalate` to `none`, for the length of `fn`. */
  async function withoutApprovalForShell(fn: () => Promise<void>): Promise<void> {
    const policies = app.get(ApprovalPolicyService, { strict: false });
    const policy = await withTestActor({ type: 'USER', id: world.ids.root }, () =>
      policies.create({ projectId: world.projectId, permissionPattern: 'fleet.job.shell.escalate', appliesTo: { kind: 'all' }, mode: 'none' }));
    try {
      await fn();
    } finally {
      await prisma.approvalPolicy.delete({ where: { id: policy.id } });
    }
  }

  /**
   * Holds `SELECT ... FOR UPDATE` on a request row from another connection while `fn` runs, then rolls back: the
   * fleet's close must skip a request an in-flight decide or execute holds (US-006 AC-14).
   */
  async function whileRequestHeld<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ApprovalRequest" WHERE "id" = ${requestId} FOR UPDATE`;
      locked();
      await released;
    }, { maxWait: 10_000, timeout: 30_000 });
    await isLocked;
    try {
      return await fn();
    } finally {
      release();
      await holder;
    }
  }

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '800';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'relay-1');
  });
  afterAll(async () => {
    await app.close();
    if (saved === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = saved;
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
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

  it('AC-1: a relayed ask opens one engine request for the job requester and one link', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('open');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000a') }] }] });

    const [link] = await linksOf(jobId);
    const [opened] = await requestsOf(jobId);
    expect(link).toMatchObject({ kind: 'bash', jobId, leaseEpoch, naxAskId: 'ask-0000000a', projectId: world.projectId, resolvedBy: null });
    expect(opened).toMatchObject({
      id: link.requestId, permissionKey: 'fleet.job.shell.escalate', status: 'pending',
      actorType: 'SYSTEM', actorId: 'runner', origin: 'runner',
      onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, projectId: world.projectId,
    });
    // The relayed payload is the ask's own input: nax's text, never the job's.
    expect((opened.input as Record<string, unknown>)['payload']).toMatchObject({ command: 'bun run test', storyId: 'US-001' });

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-2: approvalTimeoutSec 60 with the deadline 10 minutes away expires the request 60s after the relay', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('cap-timeout', { approvalTimeoutSec: 60 });
    const before = Date.now();
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000b', 600_000) }] }] });
    const after = Date.now();

    const [request] = await requestsOf(jobId);
    expect(request!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(request!.expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-3: approvalTimeoutSec 600 with the deadline 30s away expires the request at the deadline', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('cap-deadline', { approvalTimeoutSec: 600 });
    const deadlineAt = new Date(Date.now() + 30_000).toISOString();
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000c', 0, { deadlineAt }) }] }] });

    const [request] = await requestsOf(jobId);
    expect(request!.expiresAt.toISOString()).toBe(deadlineAt);

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-4: a second sync re-reporting the same ask leaves one request and one link', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('idem');
    const event = { seq: 2, type: 'approval_request' as const, payload: ask('ask-0000000d') };
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [event] }] });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ ...event, seq: 3 }] }] });

    expect(await linksOf(jobId)).toHaveLength(1);
    expect(await requestsOf(jobId)).toHaveLength(1);
    // One open audit entry: the re-reported ask is the same ask, not a second open.
    const [link] = await linksOf(jobId);
    expect(await auditRows(link!.requestId, 'bash ask')).toMatchObject([{ summary: 'bash ask opened, pending' }]);

    await finish(jobId, leaseEpoch, 4);
  });

  it('AC-5: an ask relayed for a job in raw bash mode creates no request and audits "bash ask not opened: raw mode"', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('raw', { bashMode: 'raw' });
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000e') }] }] });

    expect(await linksOf(jobId)).toHaveLength(0);
    expect(await auditRows(jobId, 'bash ask')).toMatchObject([{ summary: 'bash ask not opened: raw mode', resourceType: 'fleet-job' }]);

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-6: an ask whose deadline has passed creates no request and audits "bash ask not opened: past deadline"', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('late');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000000f', -1_000) }] }] });

    expect(await linksOf(jobId)).toHaveLength(0);
    expect(await auditRows(jobId, 'bash ask')).toMatchObject([{ summary: 'bash ask not opened: past deadline', resourceType: 'fleet-job' }]);

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-7: an ask reported after the job left RUNNING in the same sync creates no request', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('ending-ask');
    const res = await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: 2, type: 'state', payload: { to: 'UPLOADING' } },
      { seq: 3, type: 'state', payload: { to: 'COMPLETED' } },
      { seq: 4, type: 'approval_request', payload: ask('ask-00000010') },
    ] }] });

    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: 4 });
    expect(await linksOf(jobId)).toHaveLength(0);
    expect(await auditRows(jobId, 'bash ask')).toMatchObject([{ summary: 'bash ask not opened: job not running', resourceType: 'fleet-job' }]);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).state).toBe('COMPLETED');
  });

  it('AC-8: a policy that resolves the ask to none writes no request and one APPROVAL_ANSWER allow', async () => {
    await enableRelay();
    await withoutApprovalForShell(async () => {
      const { jobId, leaseEpoch } = await startRunning('no-approval');
      await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000011') }] }] });

      expect(await linksOf(jobId)).toHaveLength(0);
      expect(await prisma.approvalRequest.count({ where: { input: { path: ['naxAskId'], equals: 'ask-00000011' } } })).toBe(0);
      const commands = await prisma.fleetCommand.findMany({ where: { jobId, type: 'APPROVAL_ANSWER' } });
      expect(commands).toHaveLength(1);
      expect(commands[0]!.payload).toEqual({ approvalId: null, naxAskId: 'ask-00000011', choice: 'allow' });
      expect(await auditRows(jobId, 'bash ask')).toMatchObject([{ summary: 'bash ask answered allow: no approval needed' }]);

      await finish(jobId, leaseEpoch, 3);
    });
  });

  it('AC-9: with that policy and a truncated command the immediate answer is deny', async () => {
    await enableRelay();
    await withoutApprovalForShell(async () => {
      const { jobId, leaseEpoch } = await startRunning('no-approval-truncated');
      await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000012', 300_000, { commandTruncated: true }) }] }] });

      const commands = await prisma.fleetCommand.findMany({ where: { jobId, type: 'APPROVAL_ANSWER' } });
      expect(commands).toHaveLength(1);
      expect(commands[0]!.payload).toEqual({ approvalId: null, naxAskId: 'ask-00000012', choice: 'deny' });

      await finish(jobId, leaseEpoch, 3);
    });
  });

  it('AC-10: the pending open records approval.requested as the runner, responsible for the job requester', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('activity');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000013') }] }] });
    const [link] = await linksOf(jobId);

    const rows = await activity(jobId, 'approval.requested');
    expect(rows).toMatchObject([{ action: 'approval.requested', entityType: 'approval', entityId: link!.requestId, actorType: 'RUNNER', actorId: runner.runnerId, responsibleUserId: world.ids.dev }]);

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-11: the pending open dispatches fleet.approval.requested to the project webhook with the request id', async () => {
    await enableRelay();
    // Only this case needs a subscription: every other relay here would otherwise queue a delivery to an
    // unreachable host, which is noise (and outbox work) the rest of the file does not read.
    const webhook = await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['fleet.approval.requested', 'fleet.approval.resolved']) },
    });
    try {
      const { jobId, leaseEpoch } = await startRunning('webhook');
      await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000014') }] }] });
      const [link] = await linksOf(jobId);

      const deliveries = await prisma.outboxEvent.findMany({
        where: {
          type: 'webhook_delivery',
          AND: [{ payload: { contains: '"event":"fleet.approval.requested"' } }, { payload: { contains: `"jobId":"${jobId}"` } }],
        },
      });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.payload).toContain(`"approvalId":"${link!.requestId}"`);
      // A8: the webhook never carries the command text.
      expect(deliveries[0]!.payload).not.toContain('bun run test');

      await finish(jobId, leaseEpoch, 3);
    } finally {
      await prisma.webhook.delete({ where: { id: webhook.id } });
    }
  });

  it('AC-12: the pending open records one fleet_approval_requested outbox event keyed by the request id', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('outbox');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000015') }] }] });
    const [link] = await linksOf(jobId);

    const events = await prisma.outboxEvent.findMany({ where: { type: 'fleet_approval_requested', eventId: link!.requestId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: world.projectId, eventId: link!.requestId });

    await finish(jobId, leaseEpoch, 3);
  });

  it('AC-13: a report moving the job to COMPLETED settles its pending ask cancelled/job_ended and stamps the link', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('job-end');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000016') }] }] });
    const [link] = await linksOf(jobId);

    await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: 3, type: 'state', payload: { to: 'UPLOADING' } },
      { seq: 4, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });

    expect(await requestOf(link!.requestId)).toMatchObject({ status: 'cancelled', result: { closedBy: 'job_ended' } });
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: link!.requestId } })).resolvedBy).toBe('job_ended');
  });

  it('AC-14: while another transaction holds the ask row, the COMPLETED report commits and the ask stays pending', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('held');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000017') }] }] });
    const [link] = await linksOf(jobId);

    const res = await whileRequestHeld(link!.requestId, () =>
      sync({ jobs: [{ jobId, leaseEpoch, events: [
        { seq: 3, type: 'state', payload: { to: 'UPLOADING' } },
        { seq: 4, type: 'state', payload: { to: 'COMPLETED' } },
      ] }] }));

    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: 4 });
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).state).toBe('COMPLETED');
    expect((await requestOf(link!.requestId)).status).toBe('pending');
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: link!.requestId } })).resolvedBy).toBeNull();
  });

  it('AC-15: the job-end close records a fleet activity row approval.cancelled', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('job-end-activity');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000018') }] }] });
    const [link] = await linksOf(jobId);

    await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: 3, type: 'state', payload: { to: 'UPLOADING' } },
      { seq: 4, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });

    expect(await activity(jobId, 'approval.cancelled')).toMatchObject([
      expect.objectContaining({ action: 'approval.cancelled', entityType: 'approval', entityId: link!.requestId, actorType: 'SYSTEM', responsibleUserId: world.ids.dev }),
    ]);
  });

  it('AC-13/AC-15 (F1): the job-end close stays bounded in the transition transaction and the sweeper drains the rest', async () => {
    await enableRelay();
    const total = 205;   // three pages of MAX_PENDING_ASKS_PER_JOB, more than one bounded close settles
    const { jobId, leaseEpoch } = await startRunning('job-end-many');
    // Reported in three reports: a runner batch, not one oversized one.
    for (let first = 0; first < total; first += 35) {
      const events = Array.from({ length: Math.min(35, total - first) }, (_, i) => ({
        seq: first + i + 2,
        type: 'approval_request' as const,
        payload: ask(`ask-${(0x10000 + first + i).toString(16)}`),
      }));
      await sync({ jobs: [{ jobId, leaseEpoch, events }] });
    }
    const links = await linksOf(jobId);
    expect(links).toHaveLength(total);
    const settledCount = () => prisma.approvalRequest.count({
      where: { id: { in: links.map((l) => l.requestId) }, status: 'cancelled' },
    });

    const res = await sync({ jobs: [{ jobId, leaseEpoch, events: [
      { seq: total + 2, type: 'state', payload: { to: 'UPLOADING' } },
      { seq: total + 3, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });

    // The transition committed (no interactive-transaction timeout) and settled only its bounded share of asks.
    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: total + 3 });
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: jobId } })).state).toBe('COMPLETED');
    expect(await settledCount()).toBe(MAX_ASKS_CLOSED_PER_CALL);

    // The durable continuation finishes the job, in its own transactions, without another runner report.
    const sweeper = app.get(ApprovalJobEndSweeper, { strict: false });
    for (let tick = 0; tick < 5 && (await settledCount()) < total; tick += 1) await sweeper.tick(new Date());

    expect(await settledCount()).toBe(total);
    const settled = await prisma.approvalRequest.findMany({ where: { id: { in: links.map((l) => l.requestId) } } });
    expect(settled.filter((r) => (r.result as { closedBy?: string } | null)?.closedBy === 'job_ended')).toHaveLength(total);
    expect(await prisma.fleetApprovalAsk.count({ where: { jobId, resolvedBy: 'job_ended' } })).toBe(total);
    expect(await prisma.fleetActivity.count({ where: { jobId, action: 'approval.cancelled' } })).toBe(total);
  }, 120_000);

  it('a developer allows the ask on the engine: APPROVAL_ANSWER is delivered and the ack is accepted', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('loop');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-00000019') }] }] });
    const [link] = await linksOf(jobId);

    // A viewer holds no decide key for this ask, so the engine route does not even show it to them (404, never 403).
    await decide(link!.requestId, world.tokens.viewer).expect(404);
    await decide(link!.requestId, world.tokens.dev).expect(200);
    await decide(link!.requestId, world.tokens.dev).expect(409);

    const answer = (await sync()).commands.find((c) => c.type === 'APPROVAL_ANSWER' && c.jobId === jobId);
    expect(answer?.payload).toEqual({ approvalId: link!.requestId, naxAskId: 'ask-00000019', choice: 'allow' });
    const ackedAt = new Date();
    await sync({ commandAcks: [{ commandId: answer!.commandId, leaseEpoch, result: 'ok' }] });
    expect((await requestOf(link!.requestId)).status).toBe('executed');
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: link!.requestId } })).outcome)
      .toEqual({ delivery: { result: 'ok', detail: null, at: expect.any(String) } });
    const delivery = (await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId: link!.requestId } })).outcome as { delivery: { at: string } };
    expect(new Date(delivery.delivery.at).getTime()).toBeGreaterThanOrEqual(ackedAt.getTime());
    expect(new Date(delivery.delivery.at).getTime()).toBeLessThanOrEqual(Date.now());

    await finish(jobId, leaseEpoch, 3);
  });

  it('an unanswered ask expires through the engine sweeper; a decide after it is 409 and leaves it expired', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('expiry');
    await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: ask('ask-0000001a', 2_000) }] }] });
    const [link] = await linksOf(jobId);

    const result = await app.get(ApprovalRequestExpirySweeper, { strict: false }).tick(new Date(Date.now() + 5_000));

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await requestOf(link!.requestId)).toMatchObject({ status: 'expired' });
    await decide(link!.requestId, world.tokens.dev).expect(409);
    expect((await requestOf(link!.requestId)).status).toBe('expired');

    await finish(jobId, leaseEpoch, 3);
  });

  it('a malformed ask is a rejected event, not a sync failure (D269)', async () => {
    await enableRelay();
    const { jobId, leaseEpoch } = await startRunning('malformed');
    const res = await sync({ jobs: [{ jobId, leaseEpoch, events: [{ seq: 2, type: 'approval_request', payload: { ...ask('ask-00000010'), options: [] } }] }] });
    expect(res.jobAcks).toContainEqual({ jobId, ackedSeq: 2 });
    expect(await linksOf(jobId)).toHaveLength(0);
    await finish(jobId, leaseEpoch, 3);
  });

  it('a v1 sync is still accepted (deploy order: server first)', async () => {
    await sync({ protocolVersion: 1 });
  });
});
