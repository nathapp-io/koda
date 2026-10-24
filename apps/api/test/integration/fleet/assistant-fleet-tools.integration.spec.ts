import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b US-004 — the six fleet read tools through the real registry and executor against PG.
 *
 * Acceptance setup: project `web` (key WEB) with `dev` as its DEVELOPER and the thread's creator, project `ops`,
 * one THREAD job of project `web` held by an enrolled runner (which also hosts the log job), a second runner seen
 * ten minutes ago, FAILED/COMPLETED/ESCALATED log-bearing web jobs, an ops job, cost events in both projects,
 * approvals in both projects and a run log uploaded through the runner log route.
 *
 * The tools are found by name in `AssistantToolRegistry`, which `AssistantModule` fills through
 * `FleetTools.onModuleInit` while the app boots.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/assistant-fleet-tools.integration.spec.ts
 */
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AnalyticsService } from '../../../src/fleet/analytics/analytics.service';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { LogReadService } from '../../../src/fleet/logs/log-read.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, ThreadJobSeed } from '../../helpers/thread-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const DAY_MS = 86_400_000;
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex');
/** One nax LogEntry line, the shape the `run` stream carries. */
const line = (level: string, message: string): string =>
  `${JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', level, stage: 'run', storyId: 'US-001', message })}\n`;
/** A `ctx.data(...)` opening line. */
const FENCE_OPEN = /^<<koda-data-[0-9a-f]{16}>>$/;

/** The payloads of every `ctx.data(...)` fence in a result, in order. */
function fencedLines(content: string): string[] {
  const lines = content.split('\n');
  const values: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous !== undefined && current !== undefined && FENCE_OPEN.test(previous)) values.push(current);
  }
  return values;
}

/**
 * One block per runner of a `koda_runner_status` result: a block starts at the runner's status line, with the
 * `- ` bullet of the wire format stripped so its first line is the status itself.
 */
function runnerBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('- online: ')) blocks.push(line.slice('- '.length));
    else if (blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
  }
  return blocks;
}

describeIntegration('fleet assistant fleet tools (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let thread: ThreadJobSeed;
  let runner: { runnerId: string; apiKey: string };
  let executor: AssistantToolExecutor;
  let logs: LogReadService;
  let analytics: AnalyticsService;
  let artifactDir: string;
  const savedArtifactDir = process.env.FLEET_ARTIFACT_DIR;
  const ids: Record<string, string> = {};

  const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

  /** A job of `projectId` in the project's own repo; every field the ACs need is overridable. */
  const job = (projectId: string, data: Partial<Prisma.FleetJobUncheckedCreateInput> & { feature: string }) =>
    prisma.fleetJob.create({
      data: {
        projectId,
        repoId: projectId === world.projectId ? world.repoId : world.foreignRepoId,
        ref: 'trunk', command: 'RUN', profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5),
        requestedById: world.ids.dev, state: 'QUEUED', ...data,
      },
    });

  const cost = (projectId: string, jobId: string, callId: string, costUsd: string, tokens: { inputTokens: number; outputTokens: number }) =>
    prisma.fleetCostEvent.create({
      data: {
        jobId, leaseEpoch: 1, projectId, repoId: projectId === world.projectId ? world.repoId : world.foreignRepoId,
        runnerId: null, naxRunId: 'run-1', at: minutesAgo(60 * 24), agentName: 'native', model: 'm', modelTier: null,
        profile: null, stage: 'run', sessionRole: 'implementer', featureName: 'f', storyId: 'US-001', callId,
        ...tokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: new Prisma.Decimal(costUsd),
        pricingSource: null, confidence: null, durationMs: null,
      },
    });

  /** The runner log route (S2a §2.2), as the runner itself would append an attempt's run stream. */
  const upload = (jobId: string, body: Buffer, q: { offset?: number; final?: boolean } = {}) =>
    request(server)
      .put(`/api/fleet/runner/jobs/${jobId}/logs/run?leaseEpoch=1&offset=${q.offset ?? 0}${q.final ? '&final=1' : ''}`)
      .set({ Authorization: `Bearer ${runner.apiKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha(body) })
      .send(body)
      .expect(200);

  const call = (toolCallId: string, name: string, input: unknown) =>
    executor.execute({ jobId: thread.jobId, toolCallId, name, input });

  beforeAll(async () => {
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-fleet-tools-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    // box-a enrolled (online, and the holder of the log job's lease); box-offline last seen ten minutes ago.
    runner = await enrollRunner(server, world.tokens.root, 'box-a');
    await insertRunner(prisma, { name: 'box-offline', lastSeenAt: minutesAgo(10), createdById: world.ids.root });
    thread = await seedThreadJobFor(prisma, world, runner, { feature: 'us004-fleet' });
    executor = app.get<AssistantToolExecutor>(AssistantToolExecutor, { strict: false });
    logs = app.get<LogReadService>(LogReadService, { strict: false });
    analytics = app.get<AnalyticsService>(AnalyticsService, { strict: false });

    ids.failed = (await job(world.projectId, { feature: 'nightly-failed', state: 'FAILED', queuedAt: minutesAgo(6) })).id;
    ids.completed = (await job(world.projectId, { feature: 'nightly-done', state: 'COMPLETED', queuedAt: minutesAgo(5) })).id;
    ids.escalated = (await job(world.projectId, {
      feature: 'nightly-escalated', state: 'ESCALATED', costSpentUsd: new Prisma.Decimal('1.2345'),
      stateReason: 'acceptance failed', escalationReason: 'tests failed', queuedAt: minutesAgo(4),
    })).id;
    ids.log = (await job(world.projectId, {
      feature: 'nightly-log', state: 'RUNNING', runnerId: runner.runnerId, leaseEpoch: 1, queuedAt: minutesAgo(3),
    })).id;
    ids.expired = (await job(world.projectId, { feature: 'nightly-expired', state: 'COMPLETED', leaseEpoch: 1, queuedAt: minutesAgo(2) })).id;
    ids.opsFailed = (await job(world.opsProjectId, { feature: 'ops-failed', state: 'FAILED', queuedAt: minutesAgo(1) })).id;
    ids.opsLog = (await job(world.opsProjectId, { feature: 'ops-log', state: 'RUNNING' })).id;

    // AC-6: distinct spend in each project, one day inside the seven-day window.
    await cost(world.projectId, ids.failed, 'c-web-1', '0.5', { inputTokens: 10, outputTokens: 20 });
    await cost(world.projectId, ids.completed, 'c-web-2', '1.0', { inputTokens: 0, outputTokens: 0 });
    await cost(world.opsProjectId, ids.opsFailed, 'c-ops-1', '9.9', { inputTokens: 0, outputTokens: 0 });

    // AC-8: a pending web approval, a closed web approval and a pending ops approval.
    ids.pendingApproval = (await prisma.fleetApproval.create({
      data: {
        type: 'nax_bash_escalate', projectId: world.projectId, jobId: ids.log, leaseEpoch: 1, naxAskId: 'ask-00000001',
        payload: {}, requestedAt: minutesAgo(2),
      },
    })).id;
    ids.approvedApproval = (await prisma.fleetApproval.create({
      data: {
        type: 'nax_bash_escalate', projectId: world.projectId, jobId: ids.log, leaseEpoch: 1, naxAskId: 'ask-00000002',
        payload: {}, requestedAt: minutesAgo(2), status: 'approved',
      },
    })).id;
    ids.opsApproval = (await prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', projectId: world.opsProjectId, jobId: ids.opsLog, leaseEpoch: 1, naxAskId: 'ask-00000003', payload: {}, requestedAt: minutesAgo(1) },
    })).id;

    // AC-10/AC-11: the run log of ids.log, appended and then completed through the runner route.
    const runLog = Buffer.from(line('info', 'starting') + line('error', 'boom one') + line('error', 'boom two'), 'utf8');
    await upload(ids.log, runLog);
    await upload(ids.log, Buffer.alloc(0), { offset: runLog.length, final: true });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    if (savedArtifactDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedArtifactDir;
  });

  it('AC-2: koda_list_jobs { state: FAILED } names the FAILED web job and omits the others', async () => {
    const result = await call('ac2', 'koda_list_jobs', { state: 'FAILED' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(ids.failed);
    expect(result.content).toContain(`/web/fleet/jobs/${ids.failed}`);
    expect(result.content).not.toContain(ids.completed);
    expect(result.content).not.toContain(ids.opsFailed);
  });

  it('AC-4: koda_get_job names the state and the cost and fences the escalation reason', async () => {
    const result = await call('ac4', 'koda_get_job', { jobId: ids.escalated });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('ESCALATED');
    expect(result.content).toContain('costSpentUsd: 1.2345');
    expect(fencedLines(result.content)).toContain('tests failed');
  });

  it('AC-5: koda_get_job for an ops job answers not_found', async () => {
    const result = await call('ac5', 'koda_get_job', { jobId: ids.opsFailed });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('not_found');
  });

  it('AC-6: koda_fleet_spend answers the web-only totals over the last 7 days', async () => {
    const result = await call('ac6', 'koda_fleet_spend', { days: 7 });
    expect(result.isError).toBe(false);
    const now = new Date();
    const spend = await analytics.spend(
      world.projectId,
      { from: new Date(now.getTime() - 7 * DAY_MS).toISOString(), to: now.toISOString() },
      now,
    );
    expect(result.content).toContain(`totals.costUsd: ${spend.totals.costUsd}`);
    expect(result.content).toContain(`totals.jobs: ${spend.totals.jobs}`);
    expect(result.content).toContain(`totals.tokens: ${spend.totals.tokens}`);
    expect(result.content).toContain(`totals.medianJobCostUsd: ${spend.totals.medianJobCostUsd}`);
    // The web-only sum, not the two projects together, and not the ops amount.
    expect(result.content).toContain('totals.costUsd: 1.5000');
    expect(result.content).not.toContain('9.9000');
  });

  it('AC-8: koda_list_approvals defaults to pending and stays inside the project', async () => {
    const result = await call('ac8', 'koda_list_approvals', {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain(ids.pendingApproval);
    expect(result.content).not.toContain(ids.approvedApproval);
    expect(result.content).not.toContain(ids.opsApproval);
  });

  it('AC-9: koda_runner_status names every runner and says whether it is online', async () => {
    const result = await call('ac9', 'koda_runner_status', {});
    expect(result.isError).toBe(false);
    const blocks = runnerBlocks(result.content);
    // One block per runner row: the enrolled box-a and the ten-minute-old box-offline.
    expect(blocks).toHaveLength(await prisma.runner.count());
    const blockFor = (name: string) => blocks.find((block) => fencedLines(block).includes(name));
    // Each block's first line is the runner's status; its name is fenced under `name:`.
    expect(blockFor('box-a')?.split('\n')[0]).toBe('online: true enabled: true projectThreads: false');
    expect(blockFor('box-offline')?.split('\n')[0]).toBe('online: false enabled: true projectThreads: false');
  });

  it('AC-10: koda_job_log_excerpt { stream: run, level: error } answers the error entries and omits the info entry', async () => {
    const result = await call('ac10', 'koda_job_log_excerpt', { jobId: ids.log, stream: 'run', level: 'error' });
    expect(result.isError).toBe(false);
    expect(fencedLines(result.content)).toEqual(['boom one', 'boom two']);
    expect(result.content).not.toContain('starting');
  });

  it('AC-11: koda_job_log_excerpt starts with the scan metadata LogReadService reports', async () => {
    const result = await call('ac11', 'koda_job_log_excerpt', { jobId: ids.log });
    expect(result.isError).toBe(false);
    const reported = await logs.entries(world.projectId, ids.log, 'run', { direction: 'backward', limit: 20 });
    expect(result.content.split('\n')[0]).toBe(
      `stream run, scanned ${reported.scannedTo - reported.scannedFrom} bytes, truncated: ${reported.truncated}, complete: ${reported.complete}`,
    );
  });

  it('AC-12: koda_job_log_excerpt answers the expired result, not an error, when retention removed the stream', async () => {
    await prisma.fleetJobLog.create({
      data: { jobId: ids.expired, leaseEpoch: 1, stream: 'run', sizeBytes: 5n, complete: true, expiredAt: new Date() },
    });
    const result = await call('ac12', 'koda_job_log_excerpt', { jobId: ids.expired });
    expect(result.isError).toBe(false);
    expect(result.content).toBe(`expired: the logs of job ${ids.expired} were removed by retention`);
  });

  it('AC-13: koda_job_log_excerpt for an ops job answers not_found', async () => {
    const result = await call('ac13', 'koda_job_log_excerpt', { jobId: ids.opsLog });
    expect(result.isError).toBe(true);
    expect(result.content).toBe('not_found');
  });
});
