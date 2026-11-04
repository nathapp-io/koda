import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { NathApplication } from '@nathapp/nestjs-app';
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
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';

const now = new Date('2026-11-15T12:00:00Z');
(canRunDbTests() ? describe : describe.skip)('FIX ruling bundle results (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let runnerId: string;
  let dir: string;
  let ingest: BundleIngestService;
  let seq = 0;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-ruling-ingest-')); process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    base = await seedFleetBase(db); runnerId = (await insertRunner(db)).id;
    ingest = asTestActor(app.get(BundleIngestService), { type: 'SYSTEM', id: 'ingest' });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app?.close(); if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR; else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });
  async function fixture(state = 'COMPLETED', markedReady = false) {
    const common = { projectId: base.projectId, repoId: base.repoId, ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: '5', requestedById: base.adminId, leaseEpoch: 1 };
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: base.repoId } });
    const run = await db.fleetJob.create({ data: { ...common, command: 'RUN', feature: `work-${++seq}`, resultPrUrl: `https://github.com/${repo.owner}/${repo.name}/pull/12` } });
    const ticket = await db.ticket.create({ data: { projectId: base.projectId, number: seq, title: 'Work', type: 'TASK', status: 'IN_PROGRESS' } });
    await db.fleetJobTicket.create({ data: { jobId: run.id, ticketId: ticket.id } });
    const ruling = await db.fleetPrRuling.create({ data: { projectId: base.projectId, repoId: base.repoId, prNumber: 12, jobId: run.id, itemId: 'D-1', itemKind: 'advisor', text: 'confirm: green', disposition: 'confirmed', actorType: 'USER', actorId: base.adminId, state: 'pending' } });
    const fix = await db.fleetJob.create({ data: { ...common, command: 'FIX', state, feature: 'review-pr-12', fixReady: { markedReady }, prRulings: { headSha: 'a'.repeat(40), rulings: [{ rulingId: ruling.id, item: 'D-1', ruling: ruling.text, by: 'koda:user:dev', at: now.toISOString() }] } } });
    return { run, ticket, ruling, fix };
  }
  async function attach(id: string, callerRulings: unknown) {
    const body = await tarGz([{ name: 'nax-out/bot/pr-12/r1/bot-review.json', body: JSON.stringify({ version: 3, pr: { number: 12 }, trusted: true, events: [], callerRulings }) }]);
    const original = await db.fleetJob.findUniqueOrThrow({ where: { id } });
    await db.fleetJob.update({ where: { id }, data: { state: 'UPLOADING', runnerId } });
    const kick = vi.spyOn(app.get(BundleIngestService), 'kick').mockImplementation(() => undefined);
    try {
      await withTestActor({ type: 'RUNNER', id: runnerId }, () => app.get(BundleService).upload({ runnerId, jobId: id, leaseEpochRaw: '1', sha256Header: createHash('sha256').update(body).digest('hex'), contentType: 'application/gzip', contentLength: String(body.length), body: Readable.from([body]) }));
      await app.get(LogFallbackService).idle();
    } finally { kick.mockRestore(); }
    await db.fleetJob.update({ where: { id }, data: { state: original.state } });
  }
  const applied = { applied: [{ item: 'D-1', disposition: 'confirmed' }], skipped: [] };
  const comments = (ticketId: string) => db.comment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });
  async function rerun(id: string) {
    const kick = vi.spyOn(app.get(BundleIngestService), 'kick').mockImplementation(() => undefined);
    try { await asTestActor(app.get(IngestRequeueService), { type: 'USER', id: base.adminId }).rerunJob(base.adminId, id); await ingest.drain(now); }
    finally { kick.mockRestore(); }
  }
  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])('AC-11 %s FIX writes one system RULING summary, idempotently', async (state) => {
    const { fix, ticket, ruling } = await fixture(state); await attach(fix.id, applied); await ingest.drain(now);
    expect(await comments(ticket.id)).toEqual([expect.objectContaining({ type: 'RULING', body: `Finish ${fix.id}: applied D-1 (confirmed)`, authorUserId: null, authorAgentId: null })]);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'applied', appliedJobId: fix.id });
    await rerun(fix.id); expect(await comments(ticket.id)).toHaveLength(1);
  });
  it.each(['echo-failed', 'recorder-failed', 'head-mismatch', 'missing'])('AC-12 %s leaves pending with no summary', async (reason) => {
    const { fix, ticket, ruling } = await fixture();
    await attach(fix.id, reason === 'missing' ? undefined : reason === 'head-mismatch' ? { ignored: reason } : { skipped: [{ item: 'D-1', reason }] }); await ingest.drain(now);
    expect(await comments(ticket.id)).toEqual([]);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'pending', appliedJobId: null });
  });
  it('AC-13/14 ready comments are exact-body deduplicated and never transition tickets', async () => {
    const { fix, ticket } = await fixture('COMPLETED', true); await attach(fix.id, undefined); await ingest.drain(now); await rerun(fix.id);
    expect(await comments(ticket.id)).toEqual([expect.objectContaining({ body: `PR #12 marked ready by FIX ${fix.id}`, type: 'GENERAL', authorUserId: null, authorAgentId: null })]);
    expect(await db.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({ status: 'IN_PROGRESS' });
  });
  it('ready reports to all matching RUN tickets, not another PR or foreign URL', async () => {
    const a = await fixture('COMPLETED', true); const b = await fixture(); const other = await fixture(); const foreign = await fixture();
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: base.repoId } });
    await db.fleetJob.update({ where: { id: other.run.id }, data: { resultPrUrl: `https://github.com/${repo.owner}/${repo.name}/pull/13` } });
    await db.fleetJob.update({ where: { id: foreign.run.id }, data: { resultPrUrl: 'https://github.com/other/repo/pull/12' } });
    await attach(a.fix.id, undefined); await ingest.drain(now);
    const body = `PR #12 marked ready by FIX ${a.fix.id}`;
    expect(await db.comment.count({ where: { ticketId: a.ticket.id, body } })).toBe(1);
    expect(await db.comment.count({ where: { ticketId: b.ticket.id, body } })).toBe(1);
    expect(await db.comment.count({ where: { ticketId: { in: [other.ticket.id, foreign.ticket.id] }, body } })).toBe(0);
  });
  it.each(['/', '/?view=files#review', '?view=files#review'])('AC-13 ready includes parser-accepted RUN URL suffix %s', async (suffix) => {
    const { fix, run, ticket } = await fixture('COMPLETED', true);
    await db.fleetJob.update({ where: { id: run.id }, data: { resultPrUrl: `${run.resultPrUrl}${suffix}` } });
    await attach(fix.id, undefined); await ingest.drain(now); await rerun(fix.id);
    expect(await comments(ticket.id)).toEqual([expect.objectContaining({ body: `PR #12 marked ready by FIX ${fix.id}`, type: 'GENERAL' })]);
    expect(await db.ticket.findUnique({ where: { id: ticket.id } })).toMatchObject({ status: 'IN_PROGRESS' });
  });
  it('AC-15 default system comment remains GENERAL with null authors', async () => {
    const { ticket } = await fixture();
    await withTestActor({ type: 'SYSTEM', id: 'ingest' }, () => app.get(PrismaFleetTicketsRepository).createSystemComment(ticket.id, 'legacy'));
    expect(await comments(ticket.id)).toEqual([expect.objectContaining({ type: 'GENERAL', authorUserId: null, authorAgentId: null })]);
  });
  it('skips an existing exact summary body even when the ruling is still pending', async () => {
    const { fix, ticket, ruling } = await fixture();
    await db.comment.create({ data: { ticketId: ticket.id, type: 'RULING', body: `Finish ${fix.id}: applied D-1 (confirmed)` } });
    await attach(fix.id, applied); await ingest.drain(now);
    expect(await comments(ticket.id)).toHaveLength(1);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'applied', appliedJobId: fix.id });
  });
  it('rolls back ruling and both comments when outcome persistence fails', async () => {
    const { fix, ticket, ruling } = await fixture('COMPLETED', true); await attach(fix.id, applied);
    vi.spyOn(app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY), 'markOutcome').mockRejectedValueOnce(new Error('outcome failed'));
    await ingest.drain(now);
    expect(await comments(ticket.id)).toEqual([]);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'pending', appliedJobId: null });
    expect(await db.fleetBundleIngest.findFirst({ where: { jobId: fix.id } })).toMatchObject({ status: 'pending', attempts: 1 });
  });
  it('stale epoch cannot reconcile rulings or report ready', async () => {
    const { fix, ticket, ruling } = await fixture('COMPLETED', true); await attach(fix.id, applied);
    await db.fleetJob.update({ where: { id: fix.id }, data: { leaseEpoch: 2 } }); await ingest.drain(now);
    expect(await comments(ticket.id)).toEqual([]);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'pending' });
  });
  it('a stale snapshot never changes a re-ruled row', async () => {
    const { fix, ticket, ruling } = await fixture(); await attach(fix.id, applied);
    await db.fleetPrRuling.update({ where: { id: ruling.id }, data: { state: 'replaced' } }); await ingest.drain(now);
    expect(await comments(ticket.id)).toEqual([]);
    expect(await db.fleetPrRuling.findUnique({ where: { id: ruling.id } })).toMatchObject({ state: 'replaced', appliedJobId: null });
  });
});
