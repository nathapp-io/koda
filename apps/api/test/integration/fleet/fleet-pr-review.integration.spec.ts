import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { canRunDbTests } from '../../helpers/test-environment';
import { PrismaFleetPrReviewRepository } from '../../../src/fleet/reviews/prisma-fleet-pr-review.repository';
import { PrismaFleetRepoRepository } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import type { NathApplication } from '@nathapp/nestjs-app';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('FleetPrReview repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let reviews: PrismaFleetPrReviewRepository;
  let repos: PrismaFleetRepoRepository;
  let seq = 0;

  const project = async () => {
    const id = ++seq;
    return prisma.project.create({ data: { name: `pr review ${id}`, slug: `pr-review-${id}`, key: `PR${id}` } });
  };
  const repo = async (projectId: string, over: { autoReview?: boolean; autoReviewEnabledById?: string } = {}) =>
    prisma.fleetRepo.create({
      data: {
        projectId, provider: 'github', owner: 'acme', name: `repo-${++seq}`, defaultBranch: 'main',
        githubInstallationId: 77n, createdById: 'u0',
        autoReview: over.autoReview ?? true, autoReviewEnabledById: over.autoReviewEnabledById ?? 'u1',
        autoReviewEnabledByType: 'USER', autoReviewEnabledAt: new Date(),
      },
    });
  const id = () => ++seq;
  /** The claim a test owns; the losing claim is the case AC-2 spells out. */
  const claim = async (repoId: string) => {
    const inserted = await reviews.insertPending(repoId, 7, 'aaa');
    if (inserted === null) throw new Error('expected the head to be claimable');
    return inserted;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    reviews = asTestActor(
      new PrismaFleetPrReviewRepository(app.get(TRANSACTION_MANAGER), app.get(PrismaService)),
      { type: 'SYSTEM', id: 'seed' },
    );
    repos = asTestActor(app.get(PrismaFleetRepoRepository), { type: 'SYSTEM', id: 'seed' });
  }, 30_000);
  afterAll(async () => { await app?.close(); });

  it('AC-1: a fresh head is claimed as pending with no job', async () => {
    const r = await repo((await project()).id);
    const claim = await reviews.insertPending(r.id, 7, 'aaa');
    expect(claim).toMatchObject({ repoId: r.id, prNumber: 7, headSha: 'aaa', outcome: 'pending', jobId: null });
  });

  it('AC-2: a second claim of the same head loses and leaves one row', async () => {
    const r = await repo((await project()).id);
    expect(await reviews.insertPending(r.id, 7, 'aaa')).not.toBeNull();
    expect(await reviews.insertPending(r.id, 7, 'aaa')).toBeNull();
    expect(await prisma.fleetPrReview.count({ where: { repoId: r.id, prNumber: 7, headSha: 'aaa' } })).toBe(1);
  });

  it('AC-3: markDispatched records the job', async () => {
    const r = await repo((await project()).id);
    await reviews.markDispatched((await claim(r.id)).id, 'j1');
    expect(await reviews.findHead(r.id, 7, 'aaa')).toMatchObject({ outcome: 'dispatched', jobId: 'j1' });
  });

  it('AC-4: markFailed records the reason', async () => {
    const r = await repo((await project()).id);
    await reviews.markFailed((await claim(r.id)).id, 'failed:profiles');
    expect(await reviews.findHead(r.id, 7, 'aaa')).toMatchObject({ outcome: 'failed:profiles' });
  });

  it('AC-5: remove forgets the head', async () => {
    const r = await repo((await project()).id);
    await reviews.remove((await claim(r.id)).id);
    expect(await reviews.findHead(r.id, 7, 'aaa')).toBeNull();
  });

  it('AC-6: deleting the repo deletes its claims', async () => {
    const r = await repo((await project()).id);
    await reviews.insertPending(r.id, 7, 'aaa');
    await prisma.fleetRepo.delete({ where: { id: r.id } });
    expect(await prisma.fleetPrReview.count({ where: { repoId: r.id } })).toBe(0);
  });

  it('AC-7: a disabled user exists and is disabled', async () => {
    const userId = `disabled-${id()}`;
    const user = await prisma.user.create({
      data: { email: `${userId}@example.com`, passwordHash: 'x', disabled: true },
    });
    expect(await reviews.findPrincipalAccess({ type: 'USER', id: user.id })).toEqual({ exists: true, disabled: true });
  });

  it('AC-8: a missing user does not exist', async () => {
    expect(await reviews.findPrincipalAccess({ type: 'USER', id: `missing-${id()}` })).toEqual({ exists: false, disabled: false });
  });

  it('AC-9: an agent exists and is never disabled', async () => {
    const agentId = `agent-${id()}`;
    const agent = await prisma.agent.create({ data: { name: agentId, slug: agentId, apiKeyHash: `hash-${agentId}` } });
    expect(await reviews.findPrincipalAccess({ type: 'AGENT', id: agent.id })).toEqual({ exists: true, disabled: false });
  });

  it('AC-10: the enabler turns its own repo off', async () => {
    const r = await repo((await project()).id, { autoReview: true, autoReviewEnabledById: 'u1' });
    expect(await repos.disableAutoReviewIf(r.id, 'u1')).toBe(true);
    const row = await prisma.fleetRepo.findUnique({ where: { id: r.id } });
    expect(row).toMatchObject({
      autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null,
      autoReviewProfiles: [],
    });
    expect(row?.autoReviewMaxCostUsd.toFixed(4)).toBe('1.0000');
  });

  it('AC-11: another principal cannot turn it off', async () => {
    const r = await repo((await project()).id, { autoReview: true, autoReviewEnabledById: 'u2' });
    expect(await repos.disableAutoReviewIf(r.id, 'u1')).toBe(false);
    expect((await prisma.fleetRepo.findUnique({ where: { id: r.id } }))?.autoReview).toBe(true);
  });
});
