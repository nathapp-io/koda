import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S2a slice 1c — log retention (PG), spec §5, plus the expired-bundle 410 (D341).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-retention.integration.spec.ts
 */
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG } from '../../../src/config/fleet.config';
import { ARTIFACT_STORE } from '../../../src/fleet/artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY } from '../../../src/fleet/jobs/domain/fleet-job.domain';
import { FleetLogRetentionProcessor } from '../../../src/fleet/logs/fleet-log-retention.processor';
import { LOG_RETENTION_REPOSITORY } from '../../../src/fleet/logs/domain/log-retention.domain';
import { LOG_STORE } from '../../../src/fleet/logs/log-store';
import { PrismaFleetRepoRepository } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const DAY = 86_400_000;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_LOG_RETENTION_DAYS'] as const;

describeIntegration('fleet log retention (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let retention: FleetLogRetentionProcessor;
  let dir: string;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};
  const now = new Date();
  const before = new Date(now.getTime() - 30 * DAY);

  const job = (feature: string, over: Partial<Prisma.FleetJobUncheckedCreateInput>) => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature, profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(1), requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      finishedAt: new Date(now.getTime() - 40 * DAY), ...over,
    },
  });
  const file = (...parts: string[]) => join(dir, ...parts);
  const put = (path: string, text = 'x\n') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  /** One attempt's run log file + row, a bundle file + row, a log event and a state event. */
  const attempt = async (jobId: string, epoch: number) => {
    put(file('logs', jobId, String(epoch), 'run.log'));
    await prisma.fleetJobLog.create({ data: { jobId, leaseEpoch: epoch, stream: 'run', sizeBytes: 2n, complete: true } });
    const key = `jobs/${jobId}/${epoch}/b.tar.gz`;
    put(file(key));
    await prisma.fleetJobArtifact.create({ data: { jobId, leaseEpoch: epoch, kind: 'bundle', storageKey: key, sizeBytes: 2n, sha256: 'x' } });
    for (const type of ['log', 'state']) {
      seq += 1;
      await prisma.fleetJobEvent.create({ data: { jobId, seq, leaseEpoch: epoch, runnerSeq: seq, type, payload: {} } });
    }
  };
  /** The retention component's own pass, as `scheduledPurge` runs it. */
  const purge = (beforeDate: Date, now: Date) => withTestActor({ type: 'SYSTEM', id: 'log' }, () => retention.purge(beforeDate, now));
  /**
   * US-009: the retention worker as a restart finds it — a new instance over the same providers, so nothing
   * a purge needs may be left over in the first worker's memory. Only the committed cleanup record is.
   */
  const restartedPurge = (beforeDate: Date, now: Date) => withTestActor({ type: 'SYSTEM', id: 'log' }, () =>
    new FleetLogRetentionProcessor(
      app.get(LOG_RETENTION_REPOSITORY), app.get(FLEET_JOB_REPOSITORY), app.get(TRANSACTION_MANAGER),
      app.get(LOG_STORE), app.get(ARTIFACT_STORE), app.get(FLEET_CFG), app.get(AuditRecorder),
    ).purge(beforeDate, now));
  /** A repository of its own for a deletion test: a delete can only happen once. */
  const repoFor = (name: string) => prisma.fleetRepo.create({
    data: { projectId: world.projectId, provider: 'github', owner: 'acme', name, defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
  });
  const removeRepo = (repoId: string) => request(server).delete(`/api/fleet/repos/${repoId}`).set({ Authorization: `Bearer ${world.tokens.root}` });
  const cleanupRows = (jobId: string) => prisma.fleetRetiredJobCleanup.findMany({ where: { jobId } });
  /**
   * US-009: an abort *after* the capture. The capture is the first statement of the delete's transaction and
   * the cascade is the next one, so failing the cascade proves the captured rows roll back with the delete.
   */
  const failCascade = () => vi.spyOn(app.get(PrismaFleetRepoRepository), 'delete').mockRejectedValueOnce(new Error('cascade failed'));
  /** One selected job, expired by the same component inside its pass. */
  const expireJob = (selected: Parameters<FleetLogRetentionProcessor['expireJob']>[0], now: Date) =>
    withTestActor({ type: 'SYSTEM', id: 'log' }, () => retention.expireJob(selected, now));
  const eventTypes = async (jobId: string) =>
    (await prisma.fleetJobEvent.findMany({ where: { jobId }, orderBy: { seq: 'asc' } })).map((e) => `${e.leaseEpoch}:${e.type}`);
  const get = (path: string) => request(server).get(`/api/projects/web/fleet/jobs/${path}`).set({ Authorization: `Bearer ${world.tokens.dev}` });

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'koda-log-retention-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    process.env.FLEET_LOG_RETENTION_DAYS = '30';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    retention = app.get(FleetLogRetentionProcessor);
  });
  afterAll(async () => {
    await app.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('expires old terminal jobs only, keeps the job row and non-log events, and is idempotent', async () => {
    const old = await job('old', { leaseEpoch: 2 });
    await attempt(old.id, 1);
    await attempt(old.id, 2);
    put(file('logs', old.id, '0', 'stdout.log')); // a file whose row was never written (D343)
    const legacy = await job('legacy', { state: 'FAILED' });
    seq += 1;
    await prisma.fleetJobEvent.create({ data: { jobId: legacy.id, seq, leaseEpoch: 1, runnerSeq: seq, type: 'log', payload: {} } });
    const recent = await job('recent', { finishedAt: new Date(now.getTime() - 5 * DAY) });
    await attempt(recent.id, 1);
    const running = await job('running', { state: 'RUNNING', finishedAt: null });
    await attempt(running.id, 1);

    expect(await purge(before, now)).toEqual({ expired: 2, failed: 0 });

    for (const epoch of ['0', '1', '2']) expect(existsSync(file('logs', old.id, epoch))).toBe(false);
    expect(existsSync(file('jobs', old.id, '1', 'b.tar.gz'))).toBe(false);
    expect(existsSync(file('jobs', old.id, '2', 'b.tar.gz'))).toBe(false);
    expect((await prisma.fleetJobLog.findMany({ where: { jobId: old.id } })).every((r) => r.expiredAt?.getTime() === now.getTime())).toBe(true);
    expect((await prisma.fleetJobArtifact.findMany({ where: { jobId: old.id } })).every((r) => r.expiredAt !== null)).toBe(true);
    expect(await eventTypes(old.id)).toEqual(['1:state', '2:state']);
    expect(await eventTypes(legacy.id)).toEqual([]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'COMPLETED', leaseEpoch: 2 });

    for (const kept of [recent, running]) {
      expect(existsSync(file('logs', kept.id, '1', 'run.log'))).toBe(true);
      expect(await prisma.fleetJobLog.count({ where: { jobId: kept.id, expiredAt: { not: null } } })).toBe(0);
      expect(await eventTypes(kept.id)).toEqual(['1:log', '1:state']);
    }

    expect(await purge(before, now)).toEqual({ expired: 0, failed: 0 });
  });

  it('answers 410 for the expired logs and bundle (D341)', async () => {
    const j = await job('gone', {});
    await attempt(j.id, 1);
    await purge(before, now);
    await get(`${j.id}/bundle`).expect(410);
    await get(`${j.id}/logs/run/entries`).expect(410);
    await get(`${j.id}/logs/run/raw?download=1`).expect(410);
  });

  it('touches only attempts <= E when the job was requeued after selection (Review Focus 4)', async () => {
    const j = await job('race', {});
    await attempt(j.id, 1);
    const selected = { id: j.id, leaseEpoch: 1, finishedAt: j.finishedAt as Date };
    await prisma.fleetJob.update({ where: { id: j.id }, data: { state: 'RUNNING', leaseEpoch: 2, finishedAt: null } });
    await attempt(j.id, 2);

    await expireJob(selected, now);

    expect(existsSync(file('logs', j.id, '1'))).toBe(false);
    expect(existsSync(file('logs', j.id, '2', 'run.log'))).toBe(true);
    expect(existsSync(file('jobs', j.id, '2', 'b.tar.gz'))).toBe(true);
    const rows = await prisma.fleetJobLog.findMany({ where: { jobId: j.id }, orderBy: { leaseEpoch: 'asc' } });
    expect(rows.map((r) => [r.leaseEpoch, r.expiredAt !== null])).toEqual([[1, true], [2, false]]);
    expect(await eventTypes(j.id)).toEqual(['1:state', '2:log', '2:state']);
    await get(`${j.id}/bundle`).expect(200);
  });

  it('finishes the rows after a crash that already removed the files', async () => {
    const j = await job('crash', {});
    await attempt(j.id, 1);
    rmSync(file('logs', j.id), { recursive: true, force: true });
    rmSync(file('jobs', j.id), { recursive: true, force: true });
    expect(await purge(before, now)).toEqual({ expired: 1, failed: 0 });
    expect(await prisma.fleetJobLog.count({ where: { jobId: j.id, expiredAt: null } })).toBe(0);
  });

  /**
   * US-009 (finding 5): the repository delete cascades away the job, log and artifact rows — the only lookup for
   * the stored files — so the delete captures the cleanup targets first and the retention pass finishes the work
   * from the committed record. Every test below deletes a repository of its own through the real route.
   */
  describe('US-009 retired job cleanup after a repository delete', () => {
    it('US-009 AC-1: the restarted worker purges every captured log epoch and bundle', async () => {
      const repo = await repoFor('ac1');
      const j = await job('ac1', { repoId: repo.id, leaseEpoch: 2 });
      await attempt(j.id, 1);
      await attempt(j.id, 2);
      put(file('logs', j.id, '0', 'stdout.log')); // a file whose row was never written (D343)

      await removeRepo(repo.id).expect(204);
      // The cascade took the lookup rows with it; only the captured record still names the files.
      expect(await prisma.fleetJob.count({ where: { id: j.id } })).toBe(0);
      expect(await prisma.fleetJobLog.count({ where: { jobId: j.id } })).toBe(0);
      expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(0);
      expect(await cleanupRows(j.id)).toHaveLength(1);

      expect(await restartedPurge(before, now)).toEqual({ expired: 1, failed: 0 });

      for (const epoch of ['0', '1', '2']) expect(existsSync(file('logs', j.id, epoch))).toBe(false);
      expect(existsSync(file('jobs', j.id, '1', 'b.tar.gz'))).toBe(false);
      expect(existsSync(file('jobs', j.id, '2', 'b.tar.gz'))).toBe(false);
    });

    it('US-009 AC-2: purge removes the durable cleanup record once its targets are gone', async () => {
      const repo = await repoFor('ac2');
      const j = await job('ac2', { repoId: repo.id });
      await attempt(j.id, 1);
      await removeRepo(repo.id).expect(204);

      expect((await cleanupRows(j.id)).map((r) => [r.jobId, r.leaseEpoch, r.bundleKeys]))
        .toEqual([[j.id, 1, [`jobs/${j.id}/1/b.tar.gz`]]]);

      expect(await restartedPurge(before, now)).toEqual({ expired: 1, failed: 0 });

      expect(await cleanupRows(j.id)).toEqual([]);
    });

    it('US-009 AC-3: an unrelated job keeps its files', async () => {
      const repo = await repoFor('ac3');
      const j = await job('ac3', { repoId: repo.id });
      await attempt(j.id, 1);
      // A job of another repository that is not due: the purge reaches the deleted repo's targets only.
      const unrelated = await job('ac3-unrelated', { finishedAt: new Date(now.getTime() - 2 * DAY) });
      await attempt(unrelated.id, 1);

      await removeRepo(repo.id).expect(204);
      expect(await restartedPurge(before, now)).toEqual({ expired: 1, failed: 0 });

      expect(existsSync(file('logs', j.id, '1'))).toBe(false);
      expect(existsSync(file('jobs', j.id, '1', 'b.tar.gz'))).toBe(false);
      expect(existsSync(file('logs', unrelated.id, '1', 'run.log'))).toBe(true);
      expect(existsSync(file('jobs', unrelated.id, '1', 'b.tar.gz'))).toBe(true);
      expect(await prisma.fleetJobLog.count({ where: { jobId: unrelated.id, expiredAt: { not: null } } })).toBe(0);
    });

    it('US-009 AC-4: a removal that aborts after the capture leaves the repo, its rows and its files intact', async () => {
      const repo = await repoFor('ac4');
      // Not due at the retention cutoff: only this test's own deletion work can touch these files.
      const j = await job('ac4', { repoId: repo.id, finishedAt: new Date(now.getTime() - 5 * DAY) });
      await attempt(j.id, 1);
      const capture = vi.spyOn(app.get(PrismaFleetRepoRepository), 'captureCleanupTargets');
      const cascade = failCascade();
      try {
        await removeRepo(repo.id).expect(500);
      } finally {
        cascade.mockRestore();
      }

      // The capture ran first, and the abort rolled it back with everything else.
      expect(capture).toHaveBeenCalledWith(repo.id);
      capture.mockRestore();
      expect(await prisma.fleetRepo.count({ where: { id: repo.id } })).toBe(1);
      expect(await prisma.fleetJob.count({ where: { id: j.id } })).toBe(1);
      expect(await prisma.fleetJobLog.count({ where: { jobId: j.id } })).toBe(1);
      expect(await prisma.fleetJobArtifact.count({ where: { jobId: j.id } })).toBe(1);
      expect(existsSync(file('logs', j.id, '1', 'run.log'))).toBe(true);
      expect(existsSync(file('jobs', j.id, '1', 'b.tar.gz'))).toBe(true);
    });

    it('US-009 AC-5: the rollback leaves zero committed cleanup records', async () => {
      const repo = await repoFor('ac5');
      // Not due at the retention cutoff, for the same reason as AC-4's job.
      const j = await job('ac5', { repoId: repo.id, finishedAt: new Date(now.getTime() - 5 * DAY) });
      await attempt(j.id, 1);
      const capture = vi.spyOn(app.get(PrismaFleetRepoRepository), 'captureCleanupTargets');
      const cascade = failCascade();
      try {
        await removeRepo(repo.id).expect(500);
      } finally {
        cascade.mockRestore();
      }

      // The capture did run, inside the transaction that the abort rolled back.
      expect(capture).toHaveBeenCalledWith(repo.id);
      capture.mockRestore();
      expect(await cleanupRows(j.id)).toEqual([]);
    });

    it('US-009 AC-6: a repository with an unfinished job is still refused, and captures nothing', async () => {
      const repo = await repoFor('ac6');
      const queued = await job('ac6', { repoId: repo.id, state: 'QUEUED', finishedAt: null });
      const capture = vi.spyOn(app.get(PrismaFleetRepoRepository), 'captureCleanupTargets');

      try {
        await removeRepo(repo.id).expect(409);
      } finally {
        capture.mockRestore();
      }

      expect(await prisma.fleetRepo.count({ where: { id: repo.id } })).toBe(1);
      expect(await prisma.fleetJob.count({ where: { id: queued.id } })).toBe(1);
      expect(await cleanupRows(queued.id)).toEqual([]);
    });

    it('US-009 AC-7: a captured job newer than the cutoff survives the first purge', async () => {
      const repo = await repoFor('ac7');
      const j = await job('ac7', { repoId: repo.id, finishedAt: new Date(now.getTime() - 5 * DAY) });
      await attempt(j.id, 1);
      await removeRepo(repo.id).expect(204);
      expect(await cleanupRows(j.id)).toHaveLength(1);

      expect(await restartedPurge(before, now)).toEqual({ expired: 0, failed: 0 });

      expect(existsSync(file('logs', j.id, '1', 'run.log'))).toBe(true);
      expect(existsSync(file('jobs', j.id, '1', 'b.tar.gz'))).toBe(true);
      // The work is still owed: the record stays until its targets are deleted.
      expect(await cleanupRows(j.id)).toHaveLength(1);
    });

    it('US-009 AC-8: the next purge expires them once the cutoff has advanced past the finish time', async () => {
      const repo = await repoFor('ac8');
      // Ten days: older than AC-7's captured job, so the advanced cutoff below covers this record only.
      const finishedAt = new Date(now.getTime() - 10 * DAY);
      const j = await job('ac8', { repoId: repo.id, finishedAt });
      await attempt(j.id, 1);
      await removeRepo(repo.id).expect(204);
      expect(await restartedPurge(before, now)).toEqual({ expired: 0, failed: 0 });

      // The cutoff moves forward, as another night's run moves it, until it passes the job's finish time.
      expect(await restartedPurge(new Date(finishedAt.getTime() + 1000), now)).toEqual({ expired: 1, failed: 0 });

      expect(existsSync(file('logs', j.id, '1', 'run.log'))).toBe(false);
      expect(existsSync(file('jobs', j.id, '1', 'b.tar.gz'))).toBe(false);
      expect(await cleanupRows(j.id)).toEqual([]);
    });
  });
});
