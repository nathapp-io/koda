import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { bootHttpApp, data } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { tarGz } from '../../helpers/tar-gz';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { ARTIFACT_STORE, type ArtifactStore } from '../../../src/fleet/artifacts/artifact-store';
import { BundleIngestService } from '../../../src/fleet/ingest/bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, type IBundleIngestRepository } from '../../../src/fleet/ingest/domain/bundle-ingest.domain';
import { FleetPrRulingsService } from '../../../src/fleet/rulings/fleet-pr-rulings.service';

const headSha = 'b'.repeat(40);
(canRunDbTests() ? describe : describe.skip)('FIX ruling dispatch and RUN invalidation (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let dir: string;
  const savedDir = process.env.FLEET_ARTIFACT_DIR;
  let seq = 40;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'koda-ruling-snapshot-'));
    process.env.FLEET_ARTIFACT_DIR = dir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 60000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.FLEET_ARTIFACT_DIR; else process.env.FLEET_ARTIFACT_DIR = savedDir;
  });
  const run = (pr: number, createdAt = new Date()) => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, command: 'RUN', feature: `run-${++seq}`, ref: 'main',
    profiles: [], selectorLabels: [], maxCostUsd: '1', requestedById: world.ids.root, state: 'COMPLETED', createdAt,
    resultPrUrl: `https://github.com/acme/app/pull/${pr}`, naxRunId: 'run-1', leaseEpoch: 1,
  } });
  const ruling = (jobId: string, prNumber: number, itemId = 'D-1', state = 'pending', createdAt = new Date()) => db.fleetPrRuling.create({ data: {
    projectId: world.projectId, repoId: world.repoId, prNumber, jobId, itemId, itemKind: 'review', text: 'confirmed: test green',
    disposition: 'confirmed', actorType: 'USER', actorId: world.ids.root, state, createdAt,
  } });
  const stub = (kind: string) => {
    vi.spyOn(app.get(GitHubAppClient), 'mintReadOnlyToken').mockResolvedValue({ token: 'ephemeral', expiresAt: new Date() });
    const read = vi.spyOn(app.get(GitHubAppClient), 'getPullRequest');
    if (kind === 'throw') read.mockRejectedValue(new Error('provider down'));
    else read.mockResolvedValue(kind === 'missing' ? null : { state: kind, headSha } as never);
    return read;
  };
  const dispatch = async (command: 'FIX' | 'REVIEW', prNumber: number) => {
    const response = await request(app.getHttpServer()).post('/api/projects/web/fleet/jobs')
      .set('Authorization', `Bearer ${world.tokens.dev}`).send({ repoId: world.repoId, maxCostUsd: 1, command, prNumber }).expect(201);
    const { job } = data<{ job: { id: string } }>(response);
    return db.fleetJob.findUniqueOrThrow({ where: { id: job.id } });
  };
  it('AC-9 stores latest pending rulings and dispatch-time head, retaining them on requeue', async () => {
    const pr = ++seq;
    const older = await run(pr, new Date(0)); await ruling(older.id, pr, 'old');
    const latest = await run(pr); const row = await ruling(latest.id, pr);
    stub('open');
    const job = await dispatch('FIX', pr);
    expect(job.prRulings).toEqual({ headSha, rulings: [{ rulingId: row.id, item: 'D-1', ruling: row.text, by: 'koda:user:Root', at: row.createdAt.toISOString() }] });
    await db.fleetJob.update({ where: { id: job.id }, data: { state: 'FAILED' } });
    await request(app.getHttpServer()).post(`/api/projects/web/fleet/jobs/${job.id}/requeue`).set('Authorization', `Bearer ${world.tokens.dev}`).send({}).expect(200);
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).prRulings).toEqual(job.prRulings);
  });
  it('AC-10 REVIEW carries no rulings and does not read the head', async () => {
    const pr = ++seq; const j = await run(pr); await ruling(j.id, pr); const read = stub('open');
    expect((await dispatch('REVIEW', pr)).prRulings).toBeNull(); expect(read).not.toHaveBeenCalled();
  });
  it.each([['throw', 'head-unreadable'], ['closed', 'pr-not-open'], ['missing', 'pr-not-open']])('AC-11/15 FIX accepted with %s', async (kind, notSent) => {
    const pr = ++seq; const j = await run(pr); await ruling(j.id, pr); stub(kind);
    expect((await dispatch('FIX', pr)).prRulings).toEqual({ notSent });
  });
  it('oldest 100 pending only; remaining rulings wait for a later FIX', async () => {
    const pr = ++seq; const j = await run(pr);
    for (let i = 100; i >= 0; i--) await ruling(j.id, pr, `D-${i}`, 'pending', new Date(i * 1000));
    await ruling(j.id, pr, 'settled', 'applied', new Date(-1000));
    stub('open');
    const snapshot = await app.get(FleetPrRulingsService).snapshotForFix({ id: world.repoId, owner: 'acme', name: 'app', githubInstallationId: 77n } as never, pr);
    expect(snapshot && 'rulings' in snapshot && snapshot.rulings.map((r) => r.item)).toEqual(Array.from({ length: 100 }, (_, i) => `D-${i}`));
    expect(await db.fleetPrRuling.count({ where: { jobId: j.id, state: 'pending' } })).toBe(101);
  });
  it.each([false, true])('AC-12/13 newer RUN workflow ingest replaces older pending, preserving applied and other PRs (already mirrored: %s)', async (mirrored) => {
    const pr = ++seq; const older = await run(pr, new Date(0));
    const pending = await ruling(older.id, pr); const applied = await ruling(older.id, pr, 'B3', 'applied');
    const unrelated = await run(pr + 1000, new Date(0)); const other = await ruling(unrelated.id, pr + 1000);
    const newer = await run(pr); const current = await ruling(newer.id, pr);
    if (mirrored) await db.fleetJob.update({ where: { id: newer.id }, data: { workflow: { runId: 'run-1', outcome: 'draft', workflowPassed: true, reasons: [], openItems: [] } } });
    const gz = await tarGz([
      { name: 'nax-out/status.json', body: JSON.stringify({ run: { id: 'run-1', status: 'completed' }, workflow: { step: 'done', outcome: 'draft', url: `https://github.com/acme/app/pull/${pr}` } }) },
      { name: 'workflow/result.json', body: JSON.stringify({ schemaVersion: 1, runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03', verdict: { workflowPassed: true, outcome: 'draft', reasons: [], openItems: [] } }) },
    ]);
    const sha256 = createHash('sha256').update(gz).digest('hex'); const key = `jobs/${newer.id}/1/bundle.tar.gz`;
    await app.get<ArtifactStore>(ARTIFACT_STORE).put(key, Readable.from([gz]), { maxBytes: 1000000, expectedSha256: sha256 });
    const artifact = await db.fleetJobArtifact.create({ data: { jobId: newer.id, leaseEpoch: 1, kind: 'bundle', storageKey: key, sizeBytes: BigInt(gz.length), sha256 } });
    await withTestActor({ type: 'SYSTEM', id: 'ingest' }, async () => {
      await app.get<IBundleIngestRepository>(BUNDLE_INGEST_REPOSITORY).enqueue(artifact.id, newer.id, 1, 2);
      expect(await app.get(BundleIngestService).drain()).toBe(1);
    });
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: newer.id } })).workflow).toMatchObject({ outcome: 'draft' });
    for (const [id, state] of [[pending.id, 'replaced'], [applied.id, 'applied'], [other.id, 'pending'], [current.id, 'pending']]) {
      expect((await db.fleetPrRuling.findUniqueOrThrow({ where: { id } })).state).toBe(state);
    }
  });
});
