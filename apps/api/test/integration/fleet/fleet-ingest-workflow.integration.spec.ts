/**
 * Fleet US-005 — workflow draft ingest end to end over the real store and DB (PG), AC-13/AC-14.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-ingest-workflow.integration.spec.ts
 */
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { tarGz } from '../../helpers/tar-gz';
import { ARTIFACT_STORE, ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { ESCALATED_FROM_WORKFLOW } from '../../../src/fleet/ingest/ingest-corrections';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const boundaryReason = `${'a'.repeat(499)}😀`;
const workflowResult = JSON.stringify({
  schemaVersion: 1,
  runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
  verdict: { workflowPassed: true, outcome: 'draft', reasons: [boundaryReason], openItems: [] },
});
const statusText = JSON.stringify({
  run: { id: 'run-1', status: 'completed' },
  workflow: { step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/4' },
});

describeIntegration('fleet workflow draft ingest (PG, US-005 AC-13/AC-14)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let store: ArtifactStore;
  let ingest: BundleIngestService;
  let repo: IBundleIngestRepository;
  let artifactDir: string;
  let runnerId: string;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  const now = new Date('2026-10-06T10:00:00Z');

  beforeAll(async () => {
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-ingest-workflow-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    store = app.get<ArtifactStore>(ARTIFACT_STORE);
    ingest = app.get(BundleIngestService);
    repo = app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY);
    base = await seedFleetBase(prisma);
    runnerId = (await insertRunner(prisma)).id;
  });
  afterAll(async () => {
    await app.close();
    rmSync(artifactDir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-13/AC-14 ingests a draft workflow bundle: job ESCALATED with PR url, ticket holds the fleet pr link, activity source workflow', async () => {
    const repoRow = await prisma.fleetRepo.create({
      data: { projectId: base.projectId, provider: 'github', owner: 'o', name: 'r', defaultBranch: 'main', createdById: base.adminId },
    });
    const ticket = await prisma.ticket.create({
      data: { projectId: base.projectId, number: 1, type: 'TASK', title: 'workflow ticket', status: 'IN_PROGRESS' },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: repoRow.id, ref: 'main', command: 'RUN', feature: 'workflow-f', profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(5), requestedById: base.adminId, state: 'COMPLETED', leaseEpoch: 1, naxRunId: 'run-1',
        costSpentUsd: new Prisma.Decimal('0.0745'), finishedAt: now,
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });

    const gz = await tarGz([
      { name: 'nax-out/status.json', body: statusText },
      { name: 'workflow/result.json', body: workflowResult },
    ]);
    const key = `jobs/${job.id}/1/${sha(gz).slice(0, 8)}.tar.gz`;
    await store.put(key, Readable.from([gz]), { maxBytes: 10_000_000, expectedSha256: sha(gz) });
    const artifact = await prisma.fleetJobArtifact.upsert({
      where: { jobId_kind_leaseEpoch: { jobId: job.id, kind: 'bundle', leaseEpoch: 1 } },
      create: { jobId: job.id, leaseEpoch: 1, kind: 'bundle', storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
      update: { storageKey: key, sizeBytes: BigInt(gz.length), sha256: sha(gz) },
    });
    // The row is enqueued inside the runner's upload transaction, and the drain runs as its own component.
    await withTestActor({ type: 'RUNNER', id: runnerId }, () => repo.enqueue(artifact.id, job.id, 1, 2));

    expect(await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => ingest.drain(now))).toBe(1);

    const after = await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after).toMatchObject({ state: 'ESCALATED', stateReason: ESCALATED_FROM_WORKFLOW, resultPrUrl: 'https://github.com/o/r/pull/4' });
    expect(after.workflow).toMatchObject({ outcome: 'draft', reasons: ['a'.repeat(499)] });

    // BundleIngestService fires upsertPrLinks without awaiting it; poll briefly for the link.
    let links: Array<{ url: string }> = [];
    for (let i = 0; i < 50 && links.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      links = await prisma.ticketLink.findMany({ where: { ticketId: ticket.id } });
    }
    expect(links).toEqual([expect.objectContaining({
      url: 'https://github.com/o/r/pull/4', linkType: 'pr', source: 'fleet', jobId: job.id, prNumber: 4, externalRef: 'o/r#4',
    })]);

    const activities = await prisma.fleetActivity.findMany({ where: { jobId: job.id, action: 'job.verdict_corrected' } });
    expect(activities).toHaveLength(1);
    expect((activities[0].payload as { source?: unknown })?.source).toBe('workflow');
  });
});
