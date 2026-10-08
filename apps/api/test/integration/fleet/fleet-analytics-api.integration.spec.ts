/**
 * Fleet S2b slice 1b — project analytics routes (PG), spec §4.1-4.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-analytics-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import {
  insertAnalyticsJob, insertCostEvent, insertIngestRow, insertReviewResult, insertStoryResult,
} from '../../helpers/fleet-analytics-fixtures';
import { ESCALATED_FROM_AUDIT } from '../../../src/fleet/ingest/ingest-corrections';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const BASE = '/api/projects/web/fleet';
const WINDOW = 'from=2026-09-28T00:00:00Z&to=2026-10-05T00:00:00Z';

describeIntegration('fleet analytics project API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let agentKey: string;
  let jobId: string;
  let foreignJobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const get = (path: string, who: keyof FleetHttpWorld['tokens'] = 'viewer') => request(server).get(`${BASE}/${path}`).set(auth(who));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    agentKey = (await seedFleetHttpAgent(server, world.tokens.root)).apiKey;
    jobId = await insertAnalyticsJob(prisma, { projectId: world.projectId, repoId: world.repoId, requestedById: world.ids.dev }, {
      state: 'ESCALATED', stateReason: ESCALATED_FROM_AUDIT, costSpentUsd: '0.5', finishResult: 'escalated',
      escalationReason: 'review omitted WALK', finishedAt: new Date('2026-10-02T12:00:00Z'),
    });
    const row = { jobId, projectId: world.projectId, repoId: world.repoId };
    await insertCostEvent(prisma, row, { at: new Date('2026-10-01T10:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row, { at: new Date('2026-10-01T11:00:00Z'), model: 'm1', costUsd: '0.00004' });
    await insertCostEvent(prisma, row, { at: new Date('2026-10-02T10:00:00Z'), model: 'm2', stage: 'review', costUsd: '0.00004' });
    await insertStoryResult(prisma, row, { storyId: 'US-001', attempts: 2, firstPassSuccess: false, costUsd: '0.3', completedAt: new Date('2026-10-01T12:00:00Z') });
    await insertReviewResult(prisma, row, { reviewer: 'semantic', passed: false, findingsBySeverity: { error: 1 }, at: new Date('2026-10-01T12:30:00Z') });
    await insertIngestRow(prisma, jobId, 1, { status: 'done', liveCostUsd: '0.4', ledgerCostUsd: '0.5' });
    foreignJobId = await insertAnalyticsJob(prisma, { projectId: world.opsProjectId, repoId: world.foreignRepoId, requestedById: world.ids.root });
  });
  afterAll(async () => {
    await app.close();
  });

  it('lets any member read spend, money in four places summed before rounding', async () => {
    const s = data<{ bucket: string; totals: unknown; series: Array<{ key: string; costUsd: string; points: unknown[] }> }>(
      await get(`analytics/spend?${WINDOW}`).expect(200),
    );
    expect(s.bucket).toBe('day');
    expect(s.totals).toEqual({ costUsd: '0.0001', tokens: 330, cacheShare: 0, jobs: 1, medianJobCostUsd: '0.0001' });
    expect(s.series.map((x) => [x.key, x.costUsd])).toEqual([['m1', '0.0001'], ['m2', '0.0000']]);
    expect(s.series[0].points).toHaveLength(7);
  });

  it('folds after `top` series and rejects a top outside 1..12 (D388)', async () => {
    const s = data<{ series: Array<{ key: string; folded: boolean; costUsd: string }> }>(await get(`analytics/spend?${WINDOW}&top=1`).expect(200));
    expect(s.series.map((x) => [x.key, x.folded])).toEqual([['m1', false], ['other', true]]);
    await get(`analytics/spend?${WINDOW}&top=0`).expect(400);
    await get(`analytics/spend?${WINDOW}&top=13`).expect(400);
  });

  it('refuses outsiders and agent keys', async () => {
    await get(`analytics/spend?${WINDOW}`, 'outsider').expect(403);
    await request(server).get(`${BASE}/analytics/spend`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await request(server).get(`${BASE}/jobs/${jobId}/analytics`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
  });

  it('validates the window, the enums and the limit', async () => {
    await get('analytics/spend?groupBy=project').expect(400);
    await get('analytics/spend?groupBy=bogus').expect(400);
    await get('analytics/spend?bucket=hour').expect(400);
    await get('analytics/spend?from=yesterday').expect(400);
    await get('analytics/spend?from=2026-10-01T00:00:00').expect(400); // no Z: would parse in the server's zone
    await get('analytics/spend?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z').expect(400);
    await get('analytics/spend?from=2025-01-01T00:00:00Z&to=2026-01-03T00:00:00Z').expect(400);
    await get('analytics/stories?limit=51').expect(400);
    await get('analytics/stories?sort=duration').expect(400);
    await get('analytics/jobs?sort=attempts').expect(400);
  });

  it('answers an empty window with zeros, not an error', async () => {
    const s = data<{ totals: unknown; series: unknown[] }>(await get('analytics/spend?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').expect(200));
    expect(s).toMatchObject({ totals: { costUsd: '0.0000', tokens: 0, cacheShare: null, jobs: 0 }, series: [] });
    const q = data<{ firstPassRate: unknown; firstPassSeries: unknown[] }>(await get('analytics/quality?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z').expect(200));
    expect(q).toMatchObject({ firstPassRate: null, firstPassSeries: [{ t: '2020-01-01T00:00:00.000Z', rate: null }] });
  });

  it('reports quality, the most expensive stories and the most expensive jobs', async () => {
    expect(data(await get(`analytics/quality?${WINDOW}`).expect(200))).toMatchObject({
      stories: 1, firstPassRate: 0, avgAttempts: 2,
      reviewByReviewer: [{ reviewer: 'semantic', runs: 1, passRate: 0, findingsBySeverity: { error: 1 } }],
      finishOutcomes: { opened: 0, promoted: 0, escalated: 1, skipped: 0, other: 0 },
      topEscalationReasons: [{ reason: 'review omitted WALK', count: 1 }],
    });
    expect(data<{ rows: unknown[] }>(await get(`analytics/stories?${WINDOW}&sort=attempts&limit=5`).expect(200)).rows).toEqual([
      expect.objectContaining({ jobId, storyId: 'US-001', attempts: 2, firstPassSuccess: false, costUsd: '0.3000' }),
    ]);
    expect(data<{ rows: unknown[] }>(await get(`analytics/jobs?${WINDOW}`).expect(200)).rows).toEqual([
      expect.objectContaining({ jobId, command: 'RUN', state: 'ESCALATED', costUsd: '0.5000', ledgerCostUsd: '0.5000', driftUsd: '0.0000' }),
    ]);
  });

  it('breaks one job down and shows its ingest and correction; 404 outside the project', async () => {
    expect(data(await get(`jobs/${jobId}/analytics`).expect(200))).toMatchObject({
      jobId, corrected: true, liveCostUsd: '0.4000', ledgerCostUsd: '0.5000',
      ingest: { leaseEpoch: 1, status: 'done', files: { cost: 'done:v8' }, error: null },
      byModel: [{ key: 'm1', costUsd: '0.0001', tokens: 220 }, { key: 'm2', costUsd: '0.0000', tokens: 110 }],
      byStage: [{ key: 'run', costUsd: '0.0001', tokens: 220 }, { key: 'review', costUsd: '0.0000', tokens: 110 }],
      stories: [expect.objectContaining({ storyId: 'US-001', leaseEpoch: 1 })],
      reviews: [expect.objectContaining({ reviewer: 'semantic', passed: false })],
    });
    await get(`jobs/${foreignJobId}/analytics`).expect(404);
    await get('jobs/nope/analytics').expect(404);
  });

  it('answers the ingest counts to members and refuses agent keys (D388)', async () => {
    const r = data<{ window: unknown; pending: number; failed: number }>(await get(`analytics/ingest?${WINDOW}`).expect(200));
    expect(r).toEqual({ window: { from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' }, pending: 0, failed: 0 });
    await get(`analytics/ingest?${WINDOW}`, 'outsider').expect(403);
    await request(server).get(`${BASE}/analytics/ingest`).set({ Authorization: `Bearer ${agentKey}` }).expect(403);
    await get('analytics/ingest?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z').expect(400);
  });
});
