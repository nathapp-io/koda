/**
 * Fleet S2b slice 1a — ingest end to end over the real store and DB (PG), spec §2-§3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ingest.integration.spec.ts
 */
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { ARTIFACT_STORE, ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { BudgetEvaluator } from '../../../src/fleet/budgets/budget-evaluator';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { ESCALATED_FROM_AUDIT, NOTHING_PUSHED } from '../../../src/fleet/ingest/ingest-corrections';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const costLine = (callId: string, costUsd: number, stage = 'run') => JSON.stringify({
  ts: 1791117579984, schemaVersion: 8, agentName: 'native', model: 'minimax/MiniMax-M2.7', stage, sessionRole: 'implementer',
  featureName: 'f', storyId: 'US-001', callId, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, costUsd,
});
const statusJson = (runId: string) => JSON.stringify({ run: { id: runId, status: 'completed' }, cost: { spent: 0.0745 } });
const metricsJson = (runId: string) => JSON.stringify([{ runId, feature: 'f', stories: [{ storyId: 'US-001', attempts: 2, success: true, firstPassSuccess: false, cost: 0.15 }] }]);
const reviewJson = JSON.stringify({ timestamp: '2026-10-04T12:45:36.045Z', storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: true, failOpen: false, result: { passed: true, findings: [] } });
const finishJson = (status: string) => JSON.stringify({ status, escalationReason: 'quality review never discharged', branch: 'feat/f', headSha: 'd24d0a97', url: 'https://github.com/o/r/pull/1' });

describeIntegration('fleet bundle ingest (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let store: ArtifactStore;
  let ingest: BundleIngestService;
  let repo: IBundleIngestRepository;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  const now = new Date('2026-10-05T10:00:00Z');

  const seedJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: 'f', profiles: [], selectorLabels: [],
      maxCostUsd: new Prisma.Decimal(5), requestedById: base.adminId, state: 'COMPLETED', leaseEpoch: 1, naxRunId: 'run-1',
      costSpentUsd: new Prisma.Decimal('0.0745'), finishedAt: now, ...over,
    },
  });
  const attach = async (jobId: string, files: { name: string; body: string }[], epoch = 1) => {
    const gz = await tarGz(files);
    const key = `jobs/${jobId}/${epoch}/${sha(gz).slice(0, 8)}.tar.gz`;
    await store.put(key, Readable.from([gz]), { maxBytes: 10_000_000, expectedSha256: sha(gz) });
    const artifact = await prisma.fleetJobArtifact.upsert({
      where: { jobId_kind_leaseEpoch: { jobId, kind: 'bundle', leaseEpoch: epoch } },
      create: { jobId, leaseEpoch: epoch, kind: 'bundle', storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
      update: { storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
    });
    await repo.enqueue(artifact.id, jobId, epoch, 1);
    return artifact.id;
  };
  const fullBundle = (finish: string | null) => [
    { name: 'nax-out/cost/u.jsonl', body: [costLine('c1', 0.07), costLine('c2', 0.0873, 'finish')].join('\n') },
    { name: 'nax-out/metrics.json', body: metricsJson('run-1') },
    { name: 'nax-out/review-audit/f/1-semantic.json', body: reviewJson },
    { name: 'nax-out/status.json', body: statusJson('run-1') },
    ...(finish ? [{ name: 'nax-out/finish-audit/f/run-1.result.json', body: finishJson(finish) }] : []),
  ];

  beforeAll(async () => {
    process.env.FLEET_ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'koda-ingest-'));
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    store = app.get<ArtifactStore>(ARTIFACT_STORE);
    ingest = app.get(BundleIngestService);
    repo = app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });

  it('ingests rows, raises cost, corrects an escalated finish, and is idempotent (Review Focus 1)', async () => {
    const signal = jest.spyOn(app.get(BudgetEvaluator), 'signal').mockImplementation(() => undefined);
    const job = await seedJob();
    await attach(job.id, fullBundle('escalated'));
    expect(await ingest.drain(now)).toBe(1);

    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    expect(await prisma.fleetStoryResult.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.fleetReviewResult.count({ where: { jobId: job.id } })).toBe(1);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.costSpentUsd.toString()).toBe('0.1573');
    expect(after).toMatchObject({ state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, finishResult: 'escalated', resultPrUrl: 'https://github.com/o/r/pull/1' });
    expect(await prisma.fleetActivity.count({ where: { jobId: job.id, action: 'job.verdict_corrected' } })).toBe(1);
    const row = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row).toMatchObject({ status: 'done', files: { cost: 'done', metrics: 'done', review: 'done', finish: 'done' } });
    expect(row.ledgerCostUsd?.toString()).toBe('0.1573');
    expect(signal).toHaveBeenCalledWith(expect.arrayContaining([`project:${base.projectId}`]));

    await repo.rerunJob(job.id);
    expect(await ingest.drain(now)).toBe(1);
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    expect(await prisma.fleetActivity.count({ where: { jobId: job.id, action: 'job.verdict_corrected' } })).toBe(1);
    signal.mockRestore();
  });

  it('waits for a terminal job before ingesting', async () => {
    const job = await seedJob({ state: 'UPLOADING', finishedAt: null });
    await attach(job.id, fullBundle(null));
    expect(await ingest.drain(now)).toBe(0);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'COMPLETED', finishedAt: now } });
    expect(await ingest.drain(now)).toBe(1);
  });

  it('marks a COMPLETED run without finish or branch as nothing pushed (#204)', async () => {
    const job = await seedJob();
    await attach(job.id, fullBundle(null));
    await ingest.drain(now);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } }))).toMatchObject({ state: 'COMPLETED', stateReason: NOTHING_PUSHED });
  });

  it('raises a PLAN job cost from its ledger (#203)', async () => {
    const job = await seedJob({ command: 'PLAN', costSpentUsd: new Prisma.Decimal(0) });
    await attach(job.id, [{ name: 'nax-out/cost/u.jsonl', body: costLine('p1', 0.0044) }]);
    await ingest.drain(now);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.costSpentUsd.toString()).toBe('0.0044');
    expect(after.stateReason).toBeNull();
  });

  it('an earlier attempt adds rows but never touches the job (D367, Review Focus 2)', async () => {
    const job = await seedJob({ leaseEpoch: 2, naxRunId: 'run-2' });
    await attach(job.id, fullBundle('escalated'), 1);
    await ingest.drain(now);
    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ state: 'COMPLETED', stateReason: null });
    expect(after.costSpentUsd.toString()).toBe('0.0745');
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id, leaseEpoch: 1 } })).toBe(2);
  });

  it('a failure halfway through the write leaves nothing and backs off (Review Focus 4)', async () => {
    const job = await seedJob();
    await attach(job.id, fullBundle(null));
    const spy = jest.spyOn(repo, 'markOutcome').mockRejectedValueOnce(new Error('db went away'));
    await ingest.drain(now);
    spy.mockRestore();
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(0);
    const row = await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } });
    expect(row).toMatchObject({ status: 'pending', attempts: 1, error: 'db went away' });
    expect(row.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);
  });

  it('fails an expired bundle without retry, and analytics survive bundle expiry', async () => {
    const job = await seedJob();
    const artifactId = await attach(job.id, fullBundle(null));
    await ingest.drain(now);
    await prisma.fleetJobArtifact.update({ where: { id: artifactId }, data: { expiredAt: now } });
    expect(await prisma.fleetCostEvent.count({ where: { jobId: job.id } })).toBe(2);
    await repo.rerunJob(job.id);
    await ingest.drain(now);
    expect(await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'failed', error: 'bundle expired' });
  });

  it('records partial for an unknown cost schemaVersion and still ingests metrics', async () => {
    const job = await seedJob();
    await attach(job.id, [
      { name: 'nax-out/cost/u.jsonl', body: JSON.stringify({ schemaVersion: 99, callId: 'x' }) },
      { name: 'nax-out/metrics.json', body: metricsJson('run-1') },
      { name: 'nax-out/status.json', body: statusJson('run-1') },
    ]);
    await ingest.drain(now);
    expect(await prisma.fleetBundleIngest.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'partial', files: { cost: 'skipped:v99', metrics: 'done' } });
    expect(await prisma.fleetStoryResult.count({ where: { jobId: job.id } })).toBe(1);
  });
});
