/**
 * Fleet S2b (c) slice 1 — dashboard routes (PG): both scopes, the scope boundary, bounds, placement parity.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-dashboard-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PlacementService } from '../../../src/fleet/jobs/placement.service';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Item { key: string; kind: string; severity: string; subjectId: string; verdict?: string; reasons?: Array<{ runnerName: string; reason: string }>; conditions?: Array<Record<string, unknown>> }
interface Snapshot {
  counts: { runnersOnline: number; runnersTotal: number; queued: number; running: number; attention: number };
  runners: Array<{ name: string; naxVersion: string | null; daemonVersion: string | null; credentials: unknown[]; activeJobs: number; online: boolean }>;
  activeJobs: Array<{ id: string; pendingApprovals: number }>;
  activeTruncated: boolean;
  recentJobs: Array<{ id: string }>;
  recentTruncated: boolean;
  attention: Item[];
}

describeIntegration('fleet dashboard API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agentKey: string;
  const ids: Record<string, string> = {};
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const admin = async () => data<Snapshot>(await request(server).get('/api/fleet/dashboard').set(auth('root')).expect(200));
  const project = async (who: keyof FleetHttpWorld['tokens'] = 'viewer') =>
    request(server).get('/api/projects/web/fleet/dashboard').set(auth(who)).expect(200);
  const item = (s: Snapshot, key: string) => s.attention.find((a) => a.key === key);

  const job = (o: { projectId: string; repoId: string }, over: Partial<Prisma.FleetJobUncheckedCreateInput>) => prisma.fleetJob.create({
    data: {
      projectId: o.projectId, repoId: o.repoId, ref: 'main', command: 'RUN', profiles: ['fast'], maxCostUsd: new Prisma.Decimal(2),
      selectorLabels: [], requestedById: world.ids.root, feature: 'x', ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;
    const web = { projectId: world.projectId, repoId: world.repoId };
    const ops = { projectId: world.opsProjectId, repoId: world.foreignRepoId };

    ids.wkMac = (await insertRunner(prisma, { name: 'wk-mac', labels: ['linux'] })).id;
    ids.oldBox = (await insertRunner(prisma, {
      name: 'old-box', lastSeenAt: minutesAgo(10),
      capabilities: { ...FLEET_CAPS, nax: { version: '0.82.0', protocols: ['native'] }, credentials: [{ providerId: 'deepseek', available: false, stored: null, ambient: false }] },
    })).id;

    ids.silent = (await job(web, {
      feature: 'silent-run', state: 'RUNNING', runnerId: ids.wkMac, runnerBootId: 'boot-1', leaseEpoch: 1,
      queuedAt: minutesAgo(20), assignedAt: minutesAgo(19), startedAt: minutesAgo(18), lastHeartbeatAt: minutesAgo(12),
    })).id;
    ids.secret = (await job(ops, {
      feature: 'secret-feature', state: 'RUNNING', runnerId: ids.oldBox, runnerBootId: 'boot-1', leaseEpoch: 1,
      queuedAt: minutesAgo(17), assignedAt: minutesAgo(16), startedAt: minutesAgo(15), lastHeartbeatAt: minutesAgo(12),
    })).id;
    ids.needsGpu = (await job(web, { feature: 'needs-gpu', selectorLabels: ['gpu'], queuedAt: minutesAgo(5) })).id;
    ids.opsQueued = (await job(ops, { feature: 'ops-queued', selectorLabels: ['gpu'], queuedAt: minutesAgo(4) })).id;
    ids.doneRecent = (await job(web, { feature: 'done-recent', state: 'COMPLETED', finishedAt: minutesAgo(60) })).id;
    await job(web, { feature: 'done-old', state: 'COMPLETED', finishedAt: minutesAgo(60 * 25) });
    await prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', projectId: world.projectId, jobId: ids.silent, payload: {}, requestedAt: minutesAgo(3) },
    });

    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date() } });
    const goneRepo = await prisma.fleetRepo.create({
      data: { projectId: gone.id, provider: 'github', owner: 'acme', name: 'gone', defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: world.ids.root },
    });
    ids.ghost = (await job({ projectId: gone.id, repoId: goneRepo.id }, { feature: 'ghost-job', queuedAt: minutesAgo(30) })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses non-admins on the admin route, outsiders and agent keys on the project route', async () => {
    await request(server).get('/api/fleet/dashboard').set(auth('dev')).expect(403);
    await request(server).get('/api/projects/web/fleet/dashboard').set(auth('outsider')).expect(403);
    await request(server).get('/api/projects/web/fleet/dashboard').set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await request(server).get('/api/projects/nope/fleet/dashboard').set(auth('root')).expect(404);
  });

  it('admin scope: counts, lists and digest across projects, soft-deleted project left out', async () => {
    const s = await admin();
    expect(s.counts).toEqual({ runnersOnline: 1, runnersTotal: 2, queued: 2, running: 2, attention: s.attention.length });
    expect(s.activeJobs.map((j) => j.id)).toEqual([ids.silent, ids.secret, ids.needsGpu, ids.opsQueued]);
    expect(s.activeJobs[0].pendingApprovals).toBe(1);
    expect(s.recentJobs.map((j) => j.id)).toEqual([ids.doneRecent]);
    expect([s.activeTruncated, s.recentTruncated]).toEqual([false, false]);
    expect(s.runners.map((r) => [r.name, r.naxVersion, r.activeJobs, r.online])).toEqual([['old-box', '0.82.0', 1, false], ['wk-mac', '0.83.0', 1, true]]);
    expect(s.runners[1].credentials).toEqual([{ providerId: 'deepseek', available: true, kind: 'api-key', expiresAt: null, expired: false }]);
    expect(JSON.stringify(s)).not.toContain(ids.ghost);
  });

  it('admin scope: the four signals, errors first', async () => {
    const s = await admin();
    expect(item(s, `job_waiting_approval:${ids.silent}`)).toMatchObject({ severity: 'error' });
    expect(item(s, `job_silent:${ids.silent}`)).toMatchObject({ severity: 'error', kind: 'job_silent' });
    expect(item(s, `job_silent:${ids.secret}`)).toBeUndefined();
    expect(item(s, `runner_unhealthy:${ids.oldBox}`)).toMatchObject({
      severity: 'error',
      conditions: [{ type: 'offline', jobsHeld: 1 }, { type: 'credential', providerId: 'deepseek', why: 'unavailable' }, { type: 'stale_nax', version: '0.82.0', latest: '0.83.0' }],
    });
    expect(item(s, `job_unplaceable:${ids.needsGpu}`)).toMatchObject({
      severity: 'warning', verdict: 'no_fit', reasons: [{ runnerName: 'old-box', reason: 'offline' }, { runnerName: 'wk-mac', reason: 'labels' }],
    });
    expect(item(s, `job_unplaceable:${ids.opsQueued}`)).toMatchObject({ verdict: 'no_fit' });
    const severities = s.attention.map((a) => a.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)));
  });

  it('the dry-run agrees with placeJob on the same job (spec §2.3)', async () => {
    const outcome = await app.get(PlacementService).placeJob(ids.needsGpu);
    expect(outcome.assigned).toBe(false);
    const fromPlacement = outcome.misfits.map((m) => `${m.name}:${m.reason}`).sort();
    const fromDashboard = (item(await admin(), `job_unplaceable:${ids.needsGpu}`)?.reasons ?? []).map((r) => `${r.runnerName}:${r.reason}`).sort();
    expect(fromDashboard).toEqual(fromPlacement);
  });

  it('project scope: own jobs only, runner detail collapsed, nothing of another project leaks', async () => {
    const res = await project();
    const s = data<Snapshot>(res);
    expect(s.activeJobs.map((j) => j.id)).toEqual([ids.silent, ids.needsGpu]);
    expect(s.counts).toEqual(expect.objectContaining({ queued: 1, running: 1, runnersTotal: 2 }));
    expect(s.runners.every((r) => r.naxVersion === null && r.daemonVersion === null && r.credentials.length === 0)).toBe(true);
    expect(s.runners.map((r) => r.activeJobs)).toEqual([1, 1]);
    expect(item(s, `runner_unhealthy:${ids.oldBox}`)).toMatchObject({ severity: 'error', conditions: [{ type: 'offline', jobsHeld: 1 }, { type: 'configuration' }] });
    const json = JSON.stringify(res.body);
    expect(item(s, `job_unplaceable:${ids.needsGpu}`)).toBeDefined();
    for (const leak of [ids.secret, 'secret-feature', ids.opsQueued, 'ops-queued', world.opsProjectId, 'acme/ops', '"projectSlug":"ops"', 'deepseek', '0.82.0', '0.83.0', ids.ghost]) {
      expect(json).not.toContain(leak);
    }
  });

  it('caps the lists and flags truncation while counts stay over the full scope', async () => {
    await prisma.fleetJob.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        projectId: world.opsProjectId, repoId: world.foreignRepoId, ref: 'main', command: 'RUN', feature: `bulk-${i}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.root,
      })),
    });
    await prisma.fleetJob.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `fin-${i}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(1), selectorLabels: [], requestedById: world.ids.root, state: 'COMPLETED', finishedAt: minutesAgo(120),
      })),
    });
    const s = await admin();
    expect([s.activeJobs.length, s.activeTruncated, s.recentJobs.length, s.recentTruncated]).toEqual([200, true, 20, true]);
    expect(s.counts.queued).toBe(207);
  });
});
