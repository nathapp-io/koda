import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet REVIEW dispatch (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const dispatch = (repoId: string, prNumber = 42, command: 'REVIEW' | 'FIX' = 'REVIEW') => request(server).post('/api/projects/web/fleet/jobs')
    .set(auth()).send({ command, repoId, prNumber, maxCostUsd: 1 });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.runner.deleteMany();
  });

  it('US-003 AC-1/2/5/6/12: stores a queued GitHub review and enforces one active review per PR', async () => {
    const first = data<{ job: { id: string; state: string; feature: string }; placement: { misfits: Array<{ reason: string }> } }>(
      await dispatch(world.repoId).expect((response) => { if (response.status !== 201) throw new Error(JSON.stringify(response.body)); }),
    );
    expect(first.job).toEqual(expect.objectContaining({ state: 'QUEUED', feature: 'review-pr-42' }));
    expect(first.placement.misfits).toEqual([]);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: first.job.id } })).toEqual(expect.objectContaining({ command: 'REVIEW', feature: 'review-pr-42', state: 'QUEUED' }));
    await dispatch(world.repoId).expect(409);
  });

  it('US-002 AC-2/4/6/7: FIX shares the active PR feature with REVIEW in both directions', async () => {
    const fixed = data<{ job: { id: string; command: string; feature: string } }>(await dispatch(world.repoId, 50, 'FIX').expect(201));
    expect(fixed.job).toEqual(expect.objectContaining({ command: 'FIX', feature: 'review-pr-50' }));
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: fixed.job.id } }))
      .toEqual(expect.objectContaining({ command: 'FIX', feature: 'review-pr-50' }));
    await dispatch(world.repoId, 50, 'FIX').expect(409);
    await dispatch(world.repoId, 50, 'REVIEW').expect(409);
    const reviewed = data<{ job: { feature: string } }>(await dispatch(world.repoId, 51, 'REVIEW').expect(201));
    expect(reviewed.job.feature).toBe('review-pr-51');
    await dispatch(world.repoId, 51, 'FIX').expect(409);
  });

  it('US-002 AC-1/8: dispatches a GitLab REVIEW and FIX with a PR number', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'gitlab', owner: 'acme', name: 'gitlab-fix', defaultBranch: 'main', createdById: world.ids.root },
    });
    const review = data<{ job: { id: string; command: string; feature: string; state: string } }>(await dispatch(repo.id, 7, 'REVIEW').expect(201));
    expect(review.job).toEqual(expect.objectContaining({ command: 'REVIEW', feature: 'review-pr-7', state: 'QUEUED' }));
    // FIX shares the PR feature with REVIEW, and one repository holds one active job per feature: another PR number.
    const fix = data<{ job: { id: string; command: string; feature: string; state: string } }>(await dispatch(repo.id, 8, 'FIX').expect(201));
    expect(fix.job).toEqual(expect.objectContaining({ command: 'FIX', feature: 'review-pr-8', state: 'QUEUED' }));
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: fix.job.id } }))
      .toEqual(expect.objectContaining({ command: 'FIX', feature: 'review-pr-8', state: 'QUEUED' }));
  });

  it('US-003 AC-3/4: refuses a GitLab REVIEW without a PR number by dispatch normalization', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'gitlab', owner: 'acme', name: 'gitlab-review', defaultBranch: 'main', createdById: world.ids.root },
    });
    const reviewWithoutPr = (repoId: string) => request(server).post('/api/projects/web/fleet/jobs')
      .set(auth()).send({ command: 'REVIEW', repoId, maxCostUsd: 1 });
    const response = await reviewWithoutPr(repo.id).expect(400);
    // The provider no longer refuses: the request is normalized like a GitHub one, which needs the PR number.
    expect(String(response.body.message)).toContain('prNumber required for REVIEW');
    const github = await reviewWithoutPr(world.repoId).expect(400);
    expect(github.body.message).toBe(response.body.message);
    expect(await prisma.fleetJob.count({ where: { repoId: repo.id } })).toBe(0);
  });

  it('US-003 AC-6: reports bot_review when the only runner lacks botReview', async () => {
    await insertRunner(prisma);
    const result = data<{ job: { state: string }; placement: { misfits: Array<{ reason: string }> } }>(await dispatch(world.repoId, 44).expect(201));
    expect(result.job.state).toBe('QUEUED');
    expect(result.placement.misfits).toEqual([expect.objectContaining({ reason: 'bot_review' })]);
  });

  it('US-003: keeps FIX queued when a botReview runner lacks botFix', async () => {
    await insertRunner(prisma, { capabilities: {
      nax: { version: '0.83.0', protocols: ['native'] }, sandbox: { available: true, probedAt: new Date().toISOString() }, profiles: {},
      credentials: [], tools: { git: true, gh: true, glab: false }, executors: ['host'], botReview: true,
    } });
    const result = data<{ job: { state: string }; placement: { misfits: Array<{ reason: string }> } }>(await dispatch(world.repoId, 45, 'FIX').expect(201));
    expect(result.job.state).toBe('QUEUED');
    expect(result.placement.misfits).toEqual([expect.objectContaining({ reason: 'bot_fix' })]);
  });

  it('US-003 AC-7: accepts a review pinned to a runner without botReview', async () => {
    const runner = await insertRunner(prisma);
    const result = data<{ job: { state: string } }>(await request(server).post('/api/projects/web/fleet/jobs').set(auth())
      .send({ command: 'REVIEW', repoId: world.repoId, prNumber: 43, maxCostUsd: 1, pinnedRunnerId: runner.id }).expect(201));
    expect(result.job.state).toBe('QUEUED');
  });
});
