/**
 * Fleet S2a slice 1c — log retention (PG), spec §5, plus the expired-bundle 410 (D341).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-log-retention.integration.spec.ts
 */
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetLogRetentionProcessor } from '../../../src/fleet/logs/fleet-log-retention.processor';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
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
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
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

    expect(await retention.purge(before, now)).toEqual({ expired: 2, failed: 0 });

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

    expect(await retention.purge(before, now)).toEqual({ expired: 0, failed: 0 });
  });

  it('answers 410 for the expired logs and bundle (D341)', async () => {
    const j = await job('gone', {});
    await attempt(j.id, 1);
    await retention.purge(before, now);
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

    await retention.expireJob(selected, now);

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
    expect(await retention.purge(before, now)).toEqual({ expired: 1, failed: 0 });
    expect(await prisma.fleetJobLog.count({ where: { jobId: j.id, expiredAt: null } })).toBe(0);
  });
});
