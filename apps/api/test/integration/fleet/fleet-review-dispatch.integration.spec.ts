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
  const dispatch = (repoId: string, prNumber = 42) => request(server).post('/api/projects/web/fleet/jobs')
    .set(auth()).send({ command: 'REVIEW', repoId, prNumber, maxCostUsd: 1 });

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

  it('US-003 AC-3/4: rejects a REVIEW for a GitLab repo before dispatch normalization', async () => {
    const repo = await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'gitlab', owner: 'acme', name: 'gitlab-review', defaultBranch: 'main', createdById: world.ids.root },
    });
    const response = await dispatch(repo.id).expect((result) => { if (result.status !== 422) throw new Error(JSON.stringify(result.body)); });
    expect(JSON.stringify(response.body)).toContain('review is GitHub-only');
  });

  it('US-003 AC-6: reports bot_review when the only runner lacks botReview', async () => {
    await insertRunner(prisma);
    const result = data<{ job: { state: string }; placement: { misfits: Array<{ reason: string }> } }>(await dispatch(world.repoId, 44).expect(201));
    expect(result.job.state).toBe('QUEUED');
    expect(result.placement.misfits).toEqual([expect.objectContaining({ reason: 'bot_review' })]);
  });

  it('US-003 AC-7: accepts a review pinned to a runner without botReview', async () => {
    const runner = await insertRunner(prisma);
    const result = data<{ job: { state: string } }>(await request(server).post('/api/projects/web/fleet/jobs').set(auth())
      .send({ command: 'REVIEW', repoId: world.repoId, prNumber: 43, maxCostUsd: 1, pinnedRunnerId: runner.id }).expect(201));
    expect(result.job.state).toBe('QUEUED');
  });
});
