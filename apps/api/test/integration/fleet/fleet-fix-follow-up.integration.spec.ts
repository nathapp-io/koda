import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { FIX_FOLLOW_UP } from '../../../src/fleet/common/fix-follow-up-events';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, FLEET_CAPS, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { outboxRecord } from '../../helpers/outbox-record';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

describeIntegration('FIX follow-up review flow (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  const previousSyncWait = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) =>
    data<SyncResponse>(await request(server).post('/api/fleet/runner/sync')
      .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '0';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'fix-follow-up-runner', {
      capabilities: { ...FLEET_CAPS, botReview: true, botFix: true },
    });
  });

  afterAll(async () => {
    await app?.close();
    if (previousSyncWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = previousSyncWait;
  });

  it('AC-1–AC-6: terminal runner FIX report dispatches and idempotently claims its REVIEW follow-up', async () => {
    const prNumber = 22;
    const profiles = ['fast'];
    const maxCostUsd = 2.75;
    const resultSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const dispatched = data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs')
        .set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ command: 'FIX', repoId: world.repoId, prNumber, profiles, maxCostUsd })
        .expect(201),
    ).job;

    const assigned = await sync();
    const assign = assigned.commands.find((command) => command.jobId === dispatched.id && command.type === 'ASSIGN');
    expect(assign).toBeDefined();
    if (assign === undefined) throw new Error(`runner did not receive ASSIGN for FIX job ${dispatched.id}`);

    const report = (seq: number, type: string, payload: object) => ({ seq, type: type as 'log', payload: payload as never });
    const identity = { jobId: dispatched.id, leaseEpoch: dispatched.leaseEpoch };
    await sync({
      commandAcks: [{ commandId: assign.commandId, leaseEpoch: dispatched.leaseEpoch, result: 'ok' }],
      jobs: [{ ...identity, events: [report(1, 'state', { to: 'RUNNING' })] }],
    });
    await sync({ jobs: [{ ...identity, events: [report(2, 'snapshot', { fixOutcome: 'pushed', resultSha })] }] });
    await sync({ jobs: [{ ...identity, events: [report(3, 'state', { to: 'UPLOADING' })] }] });
    await sync({ jobs: [{ ...identity, events: [report(4, 'state', { to: 'COMPLETED' })] }] });

    const fixJob = await prisma.fleetJob.findUniqueOrThrow({ where: { id: dispatched.id } });
    expect(fixJob).toMatchObject({ state: 'COMPLETED', fixOutcome: 'pushed', resultSha });
    const outbox = await prisma.outboxEvent.findMany({ where: { type: FIX_FOLLOW_UP, eventId: `${fixJob.id}:${fixJob.leaseEpoch}:fix-follow-up` } });
    expect(outbox).toHaveLength(1);
    const row = outbox[0];
    const publisher = app.get(FanOutPublisher);
    const persistedRecord = outboxRecord(row.type, JSON.parse(row.payload) as unknown, {
      id: row.id,
      metadata: { projectId: row.projectId, eventId: row.eventId },
    });

    await publisher.publish(persistedRecord);

    const reviews = await prisma.fleetJob.findMany({ where: { command: 'REVIEW', repoId: world.repoId } });
    expect(reviews).toHaveLength(1);
    const review = reviews[0];
    expect(review).toMatchObject({
      command: 'REVIEW',
      repoId: world.repoId,
      feature: `review-pr-${prNumber}`,
      profiles,
      requestedById: fixJob.requestedById,
    });
    expect(review.maxCostUsd.toString()).toBe(fixJob.maxCostUsd.toString());

    const headClaims = await prisma.fleetPrReview.findMany({
      where: { repoId: world.repoId, prNumber, headSha: resultSha },
    });
    expect(headClaims).toHaveLength(1);
    expect(headClaims[0]).toMatchObject({ outcome: 'dispatched', jobId: review.id });

    const dispatchedAudit = await prisma.auditEntry.findMany({
      where: {
        key: 'system.pr-fix.follow-up',
        resourceType: 'fleet-job',
        resourceId: fixJob.id,
        summary: `follow-up review dispatched: ${review.id}`,
      },
    });
    expect(dispatchedAudit).toHaveLength(1);

    await publisher.publish(persistedRecord);

    expect(await prisma.fleetJob.count({ where: { command: 'REVIEW', repoId: world.repoId } })).toBe(1);
    const duplicateAudit = await prisma.auditEntry.findMany({
      where: {
        key: 'system.pr-fix.follow-up',
        resourceType: 'fleet-job',
        resourceId: fixJob.id,
        summary: 'follow-up review skipped: head_already_claimed',
      },
    });
    expect(duplicateAudit).toHaveLength(1);
  });
});
