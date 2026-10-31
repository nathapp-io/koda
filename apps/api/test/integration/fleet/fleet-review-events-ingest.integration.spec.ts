import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase, insertRunner } from '../../helpers/fleet-fixtures';
import { fixtureDb, asTestActor, withTestActor } from '../../helpers/action-context';
import { tarGz } from '../../helpers/tar-gz';
import { BundleService } from '../../../src/fleet/artifacts/bundle.service';
import { LogFallbackService } from '../../../src/fleet/logs/log-fallback.service';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, type IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { IngestRequeueService } from '../../../src/fleet/ingest/ingest-requeue.service';
import { FleetReviewEventsService } from '../../../src/fleet/reviews/fleet-review-events.service';
import type { BotReviewParse } from '../../../src/fleet/ingest/parsers/bot-review.parser';

const event = { type: 'finding-withdrawn', key: 'f-12345678', threadId: 'thread-1', finding: 'not wrong', reason: 'intended', disagreedBy: ['alice'], file: 'a.ts', line: 4 };
const parse: BotReviewParse = { outcome: 'done', trusted: true, events: [event] };
const now = new Date('2026-11-15T12:00:00Z');
const describeDb = canRunDbTests() ? describe : describe.skip;

describeDb('review event bundle ingest (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let dir: string;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  let service: FleetReviewEventsService;
  let ingest: BundleIngestService;
  let queue: IBundleIngestRepository;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-review-events-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    base = await seedFleetBase(db);
    runnerId = (await insertRunner(db)).id;
    service = asTestActor(app.get(FleetReviewEventsService), { type: 'SYSTEM', id: 'ingest' });
    ingest = asTestActor(app.get(BundleIngestService), { type: 'SYSTEM', id: 'ingest' });
    queue = app.get(BUNDLE_INGEST_REPOSITORY);
  });
  afterAll(async () => {
    await app?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR;
    else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });
  beforeEach(async () => { await db.fleetReviewEvent.deleteMany(); });

  const job = (command = 'REVIEW', state = 'COMPLETED') => db.fleetJob.create({ data: {
    projectId: base.projectId, repoId: base.repoId, ref: 'main', command, state, feature: 'review-pr-42',
    profiles: [], selectorLabels: [], maxCostUsd: '5', requestedById: base.adminId, leaseEpoch: 1, finishedAt: now,
  } });
  async function attach(jobId: string, trusted = true, invalid = false) {
    const body = await tarGz([{ name: 'nax-out/bot/pr-42/r1/bot-review.json', body: invalid ? 'not json' : JSON.stringify({ version: 3, pr: { number: 42 }, trusted, events: [event] }) }]);
    const sha = createHash('sha256').update(body).digest('hex');
    const original = await db.fleetJob.findUniqueOrThrow({ where: { id: jobId } });
    // Fixture the runner's pre-verdict state; upload enqueues in its own real transaction.
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'UPLOADING', runnerId } });
    const kick = vi.spyOn(app.get(BundleIngestService), 'kick').mockImplementation(() => undefined);
    try {
      expect(await withTestActor({ type: 'RUNNER', id: runnerId }, () => app.get(BundleService).upload({
        runnerId, jobId, leaseEpochRaw: '1', sha256Header: sha, contentType: 'application/gzip',
        contentLength: String(body.length), body: Readable.from([body]),
      }))).toMatchObject({ jobId, leaseEpoch: 1, sha256: sha });
      await app.get(LogFallbackService).idle();
    } finally { kick.mockRestore(); }
    await db.fleetJob.update({ where: { id: jobId }, data: { state: original.state } });
  }
  const rows = (jobId: string) => db.fleetReviewEvent.findMany({ where: { jobId }, take: 100 });

  it('AC-1: drains a trusted review into a pending event', async () => {
    const j = await job(); await attach(j.id);
    expect(await ingest.drain(now)).toBe(1);
    expect(await rows(j.id)).toEqual([expect.objectContaining({ status: 'pending', prNumber: 42, attempts: 0, findingKey: event.key, threadId: event.threadId, disagreedBy: ['alice'] })]);
  });
  it('AC-2: untrusted reviews are stored as skipped', async () => {
    const j = await job(); await attach(j.id, false); await ingest.drain(now);
    expect(await rows(j.id)).toEqual([expect.objectContaining({ status: 'skipped', trusted: false, skipReason: 'untrusted-pr' })]);
  });
  it('AC-3: requeue and drain preserve the existing row unchanged', async () => {
    const j = await job(); await attach(j.id); await ingest.drain(now);
    const before = await rows(j.id);
    // Hold the background kick so this test explicitly drives the second drain.
    const kick = vi.spyOn(app.get(BundleIngestService), 'kick').mockImplementation(() => undefined);
    try {
      expect(await asTestActor(app.get(IngestRequeueService), { type: 'USER', id: base.adminId }).rerunJob(base.adminId, j.id)).toEqual({ queued: 1 });
      expect(await ingest.drain(now)).toBe(1);
      expect(await rows(j.id)).toEqual(before);
      expect(before).toHaveLength(1);
    } finally { kick.mockRestore(); }
  });
  it('AC-4: FAILED review never stores events', async () => {
    const j = await job('REVIEW', 'FAILED'); await attach(j.id);
    expect(await ingest.drain(now)).toBe(1); expect(await rows(j.id)).toEqual([]);
  });
  it('AC-5: RUN never stores review events', async () => {
    const j = await job('RUN'); await attach(j.id);
    expect(await ingest.drain(now)).toBe(1); expect(await rows(j.id)).toEqual([]);
  });
  it('AC-6: invalid botReview does not make ingestion partial', async () => {
    const j = await job(); await attach(j.id, true, true); await ingest.drain(now);
    expect(await db.fleetBundleIngest.findFirstOrThrow({ where: { jobId: j.id } })).toMatchObject({ status: 'done', files: { botReview: 'invalid' } });
    expect(await rows(j.id)).toEqual([]);
  });
  it('AC-7: recordForJob counts only newly inserted pending rows', async () => {
    const j = await job();
    expect(await service.recordForJob(j, 1, parse)).toEqual({ pending: 1 });
    expect(await service.recordForJob(j, 1, parse)).toEqual({ pending: 0 });
    expect(await rows(j.id)).toHaveLength(1);
  });
  async function orderedRows() {
    const j = await job();
    for (const [threadId, hour, status] of [['ten', 10, 'pending'], ['nine', 9, 'pending'], ['eleven', 11, 'pending'], ['skipped', 8, 'skipped']] as const) {
      await db.fleetReviewEvent.create({ data: { jobId: j.id, leaseEpoch: 1, projectId: j.projectId, repoId: j.repoId, prNumber: 42, findingKey: event.key, threadId, finding: event.finding, reason: event.reason, disagreedBy: [], trusted: true, status, createdAt: new Date(`2026-11-15T${hour.toString().padStart(2, '0')}:00:00Z`) } });
    }
  }
  it('AC-8: pending reads are oldest first and do not mutate rows', async () => {
    await orderedRows();
    expect((await service.claimPending(20)).map(r => r.threadId)).toEqual(['nine', 'ten', 'eleven']);
    expect((await service.claimPending(20)).map(r => r.threadId)).toEqual(['nine', 'ten', 'eleven']);
  });
  it('AC-9: pending reads honor limit', async () => {
    await orderedRows(); expect((await service.claimPending(2)).map(r => r.threadId)).toEqual(['nine', 'ten']);
  });
  it('AC-10: attempts increment atomically and return the new count', async () => {
    const j = await job(); await service.recordForJob(j, 1, parse);
    const [row] = await rows(j.id);
    expect(await service.bumpAttempt(row.id)).toBe(1);
    expect(await service.bumpAttempt(row.id)).toBe(2);
    expect(await service.bumpAttempt(row.id)).toBe(3);
    expect((await rows(j.id))[0].attempts).toBe(3);
  });
  it('marks minted and skipped with their bookkeeping fields', async () => {
    const j = await job(); await service.recordForJob(j, 1, parse);
    const [row] = await rows(j.id);
    await service.markMinted(row.id, { memoryItemId: 'memory-1', approverLogin: 'alice' });
    expect((await rows(j.id))[0]).toMatchObject({ status: 'minted', memoryItemId: 'memory-1', approverLogin: 'alice' });
    await service.markSkipped(row.id, 'duplicate');
    expect((await rows(j.id))[0]).toMatchObject({ status: 'skipped', skipReason: 'duplicate' });
  });
  it('rolls back event insertion if the ingest outcome write fails', async () => {
    const j = await job(); await attach(j.id);
    const mark = vi.spyOn(queue, 'markOutcome').mockRejectedValueOnce(new Error('outcome failed'));
    try { await ingest.drain(now); } finally { mark.mockRestore(); }
    expect(await rows(j.id)).toEqual([]);
    expect(await db.fleetBundleIngest.findFirstOrThrow({ where: { jobId: j.id } })).toMatchObject({ status: 'pending', attempts: 1 });
  });
});
