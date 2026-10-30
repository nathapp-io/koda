import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-007 fix round 2 (F5) / US-009 — a settled ask's fleet outputs (activity row,
 * engine webhook) are recorded by the durable outbox consumer, once per
 * engine status, instead of after the decision committed.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-recorder.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { outboxRecord } from '../../helpers/outbox-record';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { ProjectEventBus } from '../../../src/live/project-event-bus';
import type { LiveEvent } from '../../../src/live/live-event';
import { APPROVAL_REQUEST_CHANGED } from '../../../src/approvals/approval-request-events';
import { FleetApprovalAskStore } from '../../../src/fleet/approvals/fleet-approval-ask.store';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet ask recorder (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let publisher: FanOutPublisher;
  let runnerId: string;
  let padmin: string;
  let n = 0;
  const seen: LiveEvent[] = [];
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const PROJECT = '/api/approvals';

  /** Permissions P3 7c US-008: the engine's decide route; the fleet's `allow` is an approve with `{ choice }`. */
  const decide = (id: string, body: object = { decision: 'approve', params: { choice: 'allow' } }) =>
    request(app.getHttpServer()).post(`${PROJECT}/${id}/decisions`).set(as(padmin)).send(body);
  const deliver = async (type: string): Promise<void> => {
    for (const row of await prisma.outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), {
        id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId },
      }));
    }
  };
  const activity = (requestId: string) => prisma.fleetActivity.findMany({ where: { entityType: 'approval', entityId: requestId } });
  const resolvedWebhooks = () => prisma.outboxEvent.count({ where: { payload: { contains: '"event":"approval.resolved"' } } });

  const pendingBashAsk = async () => {
    const running = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `rec${++n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, requestedByType: 'USER',
        state: 'RUNNING', runnerId, leaseEpoch: 1, bashMode: 'escalate', firstStartedAt: new Date(),
      },
    });
    const naxAskId = `recorded-ask-${++n}`;
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, onBehalfOf: { type: 'USER', id: world.ids.dev },
      expiresAt: new Date(Date.now() + 300_000),
      input: { jobId: running.id, leaseEpoch: 1, naxAskId, payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] } },
      link: { jobId: running.id, leaseEpoch: 1, naxAskId },
    });
    return { requestId, jobId: running.id };
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    publisher = app.get(FanOutPublisher);
    app.get(ProjectEventBus).subscribe(world.projectId, (e) => seen.push(e));
    runnerId = (await insertRunner(prisma, { createdById: world.ids.root })).id;
    await request(app.getHttpServer()).post('/api/admin/users').set(as(world.tokens.root))
      .send({ email: 'rec-admin@koda.test', name: 'rec admin', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(app.getHttpServer()).post('/api/projects/web/members').set(as(world.tokens.root))
      .send({ email: 'rec-admin@koda.test', roleKey: 'project-admin' }).expect(201);
    padmin = await loginToken(app.getHttpServer(), 'rec-admin@koda.test');
    // The engine subscription records each approval.resolved status as a webhook delivery row.
    await prisma.webhook.create({
      data: { projectId: world.projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32), events: JSON.stringify(['approval.requested', 'approval.resolved']) },
    });
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
    seen.length = 0;
  });

  it('a decide writes the durable event only; the outputs arrive with the relay, once per status', async () => {
    const { requestId } = await pendingBashAsk();

    await decide(requestId).expect(200);

    // The engine wrote the event inside the deciding transaction; the adapter writes no fleet outputs of its own.
    const events = await prisma.outboxEvent.findMany({ where: { type: APPROVAL_REQUEST_CHANGED } });
    expect(events.map((e) => JSON.parse(e.payload).status)).toContain('executed');
    expect(await activity(requestId)).toEqual([]);
    expect(await resolvedWebhooks()).toBe(2);
    expect(seen).toEqual([]);

    await deliver(APPROVAL_REQUEST_CHANGED);

    expect(await activity(requestId)).toMatchObject([{ action: 'approval.decided', actorType: 'USER', entityType: 'approval' }]);
    expect(await resolvedWebhooks()).toBe(2);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'approval_request', requestId, status: 'executed' }));
    expect(seen.map(e => e.type)).not.toContain('fleet_approval');
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } }))).toMatchObject({ recordedStatus: 'executed', resolvedBy: 'user' });

    // Recording is idempotent per engine status; a redelivery writes no second activity row.
    await deliver(APPROVAL_REQUEST_CHANGED);
    expect(await activity(requestId)).toHaveLength(1);
    expect(await resolvedWebhooks()).toBe(2);
    expect(seen.map(e => e.type)).not.toContain('fleet_approval');
  });

  it('fix round 3: two concurrent deliveries of the same event record the outputs once', async () => {
    const { requestId } = await pendingBashAsk();
    await decide(requestId).expect(200);
    const events = await prisma.outboxEvent.findMany({ where: { type: APPROVAL_REQUEST_CHANGED } });
    const records = events.map((row) => outboxRecord(row.type, JSON.parse(row.payload), {
      id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId },
    }));

    // Both deliveries run at once: the link lock serialises their recording.
    await Promise.all(records.flatMap((record) => [publisher.publish(record), publisher.publish(record)]));

    // The link lock makes concurrent redeliveries claim the activity marker once.
    expect(await activity(requestId)).toHaveLength(1);
    expect(await resolvedWebhooks()).toBe(2);
    expect(seen.map(e => e.type)).not.toContain('fleet_approval');
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).recordedStatus).toBe('executed');
  });

  it('US-009: a marker write failure rolls the outputs back and the retried delivery records them once', async () => {
    const { requestId } = await pendingBashAsk();
    await decide(requestId).expect(200);
    const fail = vi.spyOn(app.get(FleetApprovalAskStore), 'setRecordedStatus').mockRejectedValueOnce(new Error('marker unavailable'));
    try {
      await expect(deliver(APPROVAL_REQUEST_CHANGED)).rejects.toThrow('marker unavailable');
      // Nothing of the rolled-back attempt survives: no activity row or recordedStatus change.
      expect(await activity(requestId)).toEqual([]);
      expect(await resolvedWebhooks()).toBe(2);
      expect(seen.map(e => e.type)).not.toContain('fleet_approval');
      expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).recordedStatus).toBeNull();

      await deliver(APPROVAL_REQUEST_CHANGED);
      expect(await activity(requestId)).toHaveLength(1);
      expect(await resolvedWebhooks()).toBe(2);
      expect(seen.map(e => e.type)).not.toContain('fleet_approval');
      expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).recordedStatus).toBe('executed');
    } finally {
      fail.mockRestore();
    }
  });

  it('F6 round 4: an executed job_ended ask records the cancelled fleet view, and a linkless ask records nothing', async () => {
    const { requestId } = await pendingBashAsk();
    await prisma.approvalRequest.update({ where: { id: requestId }, data: { status: 'executed' } });
    await prisma.fleetApprovalAsk.update({ where: { requestId }, data: { resolvedBy: 'job_ended' } });
    const record = outboxRecord(APPROVAL_REQUEST_CHANGED, {
      requestId, status: 'executed', projectId: world.projectId, permissionKey: 'fleet.job.shell.escalate',
      requiredMode: 'agent', actorType: 'SYSTEM', actorId: 'runner', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev,
      expiresAt: new Date().toISOString(),
    });
    await publisher.publish(record);
    expect(await activity(requestId)).toMatchObject([{ action: 'approval.cancelled' }]);
    expect(seen).toContainEqual(expect.objectContaining({ type: 'approval_request', requestId, status: 'executed' }));
    await prisma.fleetApprovalAsk.delete({ where: { requestId } });
    seen.length = 0;
    await publisher.publish(record);
    expect(seen.map(e => e.type)).not.toContain('fleet_approval');
    expect(await activity(requestId)).toHaveLength(1);
  });

  it('an expired ask records the expiry, fills the link timeout and answers to the system', async () => {
    const { requestId } = await pendingBashAsk();
    await prisma.approvalRequest.update({
      where: { id: requestId }, data: { status: 'expired', settledAt: new Date(), approverId: null, approverType: null },
    });

    await publisher.publish(outboxRecord(APPROVAL_REQUEST_CHANGED, {
      requestId, status: 'expired', projectId: world.projectId, permissionKey: 'fleet.job.shell.escalate',
      requiredMode: 'agent', actorType: 'SYSTEM', actorId: 'runner', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev,
      expiresAt: new Date().toISOString(),
    }));

    expect(await activity(requestId)).toMatchObject([{ action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: world.ids.dev }]);
    expect((await prisma.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } }))).toMatchObject({ recordedStatus: 'expired', resolvedBy: 'timeout' });
    expect(await activity(requestId)).toHaveLength(1);
  });

  it('an event for a non-fleet key records nothing', async () => {
    await publisher.publish(outboxRecord(APPROVAL_REQUEST_CHANGED, {
      requestId: 'not-a-fleet-ask', status: 'executed', projectId: world.projectId, permissionKey: 'role.manage',
      requiredMode: 'human', actorType: 'USER', actorId: world.ids.root, onBehalfOfType: null, onBehalfOfId: null,
      expiresAt: new Date().toISOString(),
    }));

    expect(await activity('not-a-fleet-ask')).toEqual([]);
    expect(await resolvedWebhooks()).toBe(0);
  });
});
