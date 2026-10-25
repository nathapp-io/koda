import { canRunDbTests } from '../../helpers/test-environment';
/* eslint-disable @typescript-eslint/no-non-null-assertion -- preceding expect(...).toBeDefined() checks document command presence. */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, type FleetHttpWorld, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import type { SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

describeIntegration('audit runner sync integration (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let recorder: AuditRecorder;
  const savedWait = process.env.FLEET_SYNC_WAIT_MS;

  const sync = async (over: Partial<SyncRequest> = {}) => data<SyncResponse>(await request(server).post('/api/fleet/runner/sync')
    .set({ Authorization: `Bearer ${runner.apiKey}` }).send(syncBody(over)).expect(200));
  const dispatch = async (feature: string) => data<{ job: { id: string; leaseEpoch: number } }>(
    await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
      .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
  ).job;
  const jobEntries = (id: string) => prisma.auditEntry.findMany({ where: { key: 'runner.sync', resourceType: 'fleet-job', resourceId: id }, orderBy: { createdAt: 'asc' } });
  const start = async (feature: string, repoId = world.repoId) => {
    const j = data<{ job: { id: string; leaseEpoch: number } }>(
      await request(server).post('/api/projects/web/fleet/jobs').set({ Authorization: `Bearer ${world.tokens.dev}` })
        .send({ repoId, command: 'RUN', maxCostUsd: 5, feature }).expect(201),
    ).job;
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN');
    expect(assign).toBeDefined();
    await sync({ commandAcks: [{ commandId: assign!.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }], jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    return j;
  };
  const finishAll = () => prisma.fleetJob.updateMany({ where: { state: { in: ['ASSIGNED', 'RUNNING', 'UPLOADING'] } }, data: { state: 'COMPLETED' } });

  beforeAll(async () => {
    process.env.FLEET_SYNC_WAIT_MS = '800';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    recorder = app.get(AuditRecorder);
    world = await seedFleetHttpWorld(server, prisma);
    runner = await enrollRunner(server, world.tokens.root, 'audit-runner');
  });
  afterAll(async () => {
    await app.close();
    if (savedWait === undefined) delete process.env.FLEET_SYNC_WAIT_MS;
    else process.env.FLEET_SYNC_WAIT_MS = savedWait;
  });
  afterEach(async () => { await finishAll(); vi.restoreAllMocks(); });

  it('AC-1/2/3: audits each applied report transition once and ignores exact resends', async () => {
    const j = await dispatch('audit-report-transitions');
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'ok' }], jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
      { seq: 2, type: 'state', payload: { to: 'UPLOADING' } }, { seq: 3, type: 'state', payload: { to: 'COMPLETED' } },
    ] }] });
    const events = [{ seq: 2, type: 'state', payload: { to: 'UPLOADING' } }, { seq: 3, type: 'state', payload: { to: 'COMPLETED' } }];
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events }] });
    const rows = await jobEntries(j.id);
    expect(rows.map((row) => row.summary)).toEqual(['ASSIGNED -> RUNNING', 'RUNNING -> UPLOADING', 'UPLOADING -> COMPLETED']);
    expect(rows[0]).toEqual(expect.objectContaining({ projectId: world.projectId, actorType: 'RUNNER', actorId: runner.runnerId, origin: 'runner' }));
  });

  it('AC-4/5/6/11: refused, mirror, stale-fence and idle bookkeeping create no job entries', async () => {
    const j = await start('audit-noop-events');
    const before = await jobEntries(j.id);
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [
      { seq: 2, type: 'state', payload: { to: 'QUEUED' } }, { seq: 3, type: 'snapshot', payload: { costSpentUsd: '1' } },
    ] }] });
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).state).toBe('RUNNING');
    expect(await prisma.fleetActivity.count({ where: { jobId: j.id, action: 'job.event_rejected' } })).toBe(1);
    expect(await jobEntries(j.id)).toHaveLength(before.length);
    await prisma.fleetJob.update({ where: { id: j.id }, data: { leaseEpoch: j.leaseEpoch + 1 } });
    await sync({ jobs: [{ jobId: j.id, leaseEpoch: j.leaseEpoch, events: [{ seq: 4, type: 'state', payload: { to: 'UPLOADING' } }] }] });
    expect(await jobEntries(j.id)).toHaveLength(before.length);
    const actorCount = await prisma.auditEntry.count({ where: { key: 'runner.sync', actorId: runner.runnerId } });
    const currentBoot = (await prisma.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).bootId;
    await sync({ bootId: currentBoot });
    expect(await prisma.auditEntry.count({ where: { key: 'runner.sync', actorId: runner.runnerId } })).toBe(actorCount);
  });

  it('AC-7/9/10: rejected command transitions audit, successful READOPT does not', async () => {
    const failed = await dispatch('audit-rejected-assign');
    const assign = (await sync()).commands.find((c) => c.jobId === failed.id && c.type === 'ASSIGN')!;
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: failed.leaseEpoch, result: 'rejected', detail: 'no capacity' }] });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ state: 'FAILED' });
    expect((await jobEntries(failed.id)).map((row) => row.summary)).toEqual(['ASSIGNED -> FAILED']);

    const cancelled = await start('audit-rejected-cancel');
    await request(server).post(`/api/projects/web/fleet/jobs/${cancelled.id}/cancel`).set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200);
    const cancel = (await sync()).commands.find((c) => c.jobId === cancelled.id && c.type === 'CANCEL')!;
    await sync({ commandAcks: [{ commandId: cancel.commandId, leaseEpoch: cancelled.leaseEpoch, result: 'rejected' }] });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: cancelled.id } })).toMatchObject({ state: 'CANCELLED' });
    expect((await jobEntries(cancelled.id)).map((row) => row.summary)).toEqual(['ASSIGNED -> RUNNING', 'RUNNING -> CANCELLED']);

    const keep = await start('audit-readopt-ok');
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 2 } });
    const repo2 = await prisma.fleetRepo.create({ data: { projectId: world.projectId, provider: 'github', owner: 'acme', name: 'audit-app2', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root } });
    const lose = await start('audit-readopt-reject', repo2.id);
    const priorKeep = (await jobEntries(keep.id)).length;
    const reboot = await sync({ bootId: 'audit-boot-2' });
    const readopts = reboot.commands.filter((c) => c.type === 'READOPT');
    expect(readopts.map((c) => c.jobId)).toEqual(expect.arrayContaining([keep.id, lose.id]));
    const runnerEntry = await prisma.auditEntry.findFirstOrThrow({ where: { key: 'runner.sync', resourceType: 'fleet-runner', resourceId: runner.runnerId } });
    expect(runnerEntry).toEqual(expect.objectContaining({
      key: 'runner.sync', resourceType: 'fleet-runner', resourceId: runner.runnerId, projectId: null,
      actorType: 'RUNNER', actorId: runner.runnerId, origin: 'runner', summary: 'rebooted, 2 readopts queued',
    }));
    const byJob = new Map(readopts.map((c) => [c.jobId, c]));
    await sync({ bootId: 'audit-boot-2', commandAcks: [
      { commandId: byJob.get(keep.id)!.commandId, leaseEpoch: keep.leaseEpoch, result: 'ok' },
      { commandId: byJob.get(lose.id)!.commandId, leaseEpoch: lose.leaseEpoch, result: 'rejected' },
    ] });
    expect(await jobEntries(keep.id)).toHaveLength(priorKeep);
    expect((await jobEntries(lose.id)).map((row) => row.summary)).toContain('RUNNING -> CRASHED');
    expect(repo2.id).toBeTruthy();
    await prisma.runner.update({ where: { id: runner.runnerId }, data: { capacity: 1, bootId: 'boot-1' } });
  });

  it('AC-12/13/14: a rejected audit rolls back the transition and the ack remains retryable', async () => {
    const j = await dispatch('audit-failure');
    const assign = (await sync()).commands.find((c) => c.jobId === j.id && c.type === 'ASSIGN')!;
    const record = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === 'runner.sync') throw new Error('audit unavailable');
    });
    await sync({ commandAcks: [{ commandId: assign.commandId, leaseEpoch: j.leaseEpoch, result: 'rejected' }] });
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).toMatchObject({ state: 'ASSIGNED' });
    expect(await prisma.fleetCommand.findUniqueOrThrow({ where: { id: assign.commandId } })).toMatchObject({ ackedAt: null });
    record.mockRestore();
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'FAILED' } });
    const reportJob = await dispatch('audit-report-failure');
    const reportAck = (await sync()).commands.find((c) => c.jobId === reportJob.id && c.type === 'ASSIGN')!;
    const rejectReport = vi.spyOn(recorder, 'record').mockRejectedValue(new Error('audit unavailable'));
    const reportResponse = await sync({ commandAcks: [{ commandId: reportAck.commandId, leaseEpoch: reportJob.leaseEpoch, result: 'ok' }], jobs: [{ jobId: reportJob.id, leaseEpoch: reportJob.leaseEpoch, events: [{ seq: 1, type: 'state', payload: { to: 'RUNNING' } }] }] });
    expect(reportResponse.jobAcks).toEqual([]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: reportJob.id } })).toMatchObject({ state: 'ASSIGNED' });
    expect(await jobEntries(reportJob.id)).toHaveLength(0);
    rejectReport.mockRestore();

    const activityCount = await prisma.fleetActivity.count({ where: { entityType: 'runner', entityId: runner.runnerId, action: 'runner.rebooted' } });
    const auditCount = await prisma.auditEntry.count({ where: { key: 'runner.sync', resourceType: 'fleet-runner', resourceId: runner.runnerId } });
    const rebootFailure = vi.spyOn(recorder, 'record').mockRejectedValue(new Error('audit unavailable'));
    const rebootResponse = await sync({ bootId: 'audit-boot-failure' });
    expect(rebootResponse).toBeDefined();
    expect(await prisma.fleetActivity.count({ where: { entityType: 'runner', entityId: runner.runnerId, action: 'runner.rebooted' } })).toBe(activityCount);
    expect(await prisma.auditEntry.count({ where: { key: 'runner.sync', resourceType: 'fleet-runner', resourceId: runner.runnerId } })).toBe(auditCount);
    rebootFailure.mockRestore();
  });
});
