import { canRunDbTests } from '../../helpers/test-environment';
import { PrismaFleetRepoRepository } from '../../../src/fleet/repos/prisma-fleet-repo.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import type { NathApplication } from '@nathapp/nestjs-app';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('FleetRepo auto-review repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repos: PrismaFleetRepoRepository;
  let seq = 0;
  const project = async (deletedAt: Date | null = null) => {
    const id = ++seq;
    return prisma.project.create({ data: { name: `review ${id}`, slug: `review-${id}`, key: `RV${id}`, deletedAt } });
  };
  const create = async (projectId: string, over: Partial<{ provider: string; githubInstallationId: bigint | null }> & { name: string }) =>
    repos.create({ projectId, provider: over.provider ?? 'github', owner: 'acme', name: over.name, defaultBranch: 'main',
      githubInstallationId: over.githubInstallationId === undefined ? 77n : over.githubInstallationId, createdById: 'actor' });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    repos = asTestActor(app.get(PrismaFleetRepoRepository), { type: 'SYSTEM', id: 'seed' });
  }, 30_000);
  afterAll(async () => { await app?.close(); });

  it('AC-1: registration input without auto-review fields reads default false', async () => {
    const p = await project();
    expect((await create(p.id, { name: 'default-off' })).autoReview).toBe(false);
  });

  it('AC-2: registration input reads the default profiles and cost', async () => {
    const p = await project();
    const inserted = await create(p.id, { name: 'default-values' });
    const row = await repos.findById(inserted.id);
    expect(row).toMatchObject({ autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000' });
  });

  it('AC-6: returns an enabled GitHub repo with an installation', async () => {
    const p = await project();
    const inserted = await create(p.id, { name: 'eligible' });
    await prisma.fleetRepo.update({ where: { id: inserted.id }, data: { autoReview: true } });
    expect((await repos.findAutoReviewPage(50)).map((r) => r.id)).toContain(inserted.id);
  });

  it('AC-7: excludes enabled repos in soft-deleted projects', async () => {
    const p = await project(new Date());
    const inserted = await create(p.id, { name: 'deleted-project' });
    await prisma.fleetRepo.update({ where: { id: inserted.id }, data: { autoReview: true } });
    expect((await repos.findAutoReviewPage(50)).map((r) => r.id)).not.toContain(inserted.id);
  });

  it('AC-8: excludes repos whose auto-review flag is false', async () => {
    const p = await project();
    const inserted = await create(p.id, { name: 'disabled' });
    expect((await repos.findAutoReviewPage(50)).map((r) => r.id)).not.toContain(inserted.id);
  });

  it('AC-9: excludes enabled repos without a GitHub installation', async () => {
    const p = await project();
    const inserted = await create(p.id, { name: 'no-installation', githubInstallationId: null });
    await prisma.fleetRepo.update({ where: { id: inserted.id }, data: { autoReview: true } });
    expect((await repos.findAutoReviewPage(50)).map((r) => r.id)).not.toContain(inserted.id);
  });

  it('AC-10: limits results and orders enabled repos by id', async () => {
    await prisma.fleetRepo.updateMany({ data: { autoReview: false } });
    const p = await project();
    const rows = await Promise.all(['a', 'b', 'c'].map((name) => create(p.id, { name })));
    await prisma.fleetRepo.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { autoReview: true } });
    const page = await repos.findAutoReviewPage(2);
    const expected = rows.map((r) => r.id).sort().slice(0, 2);
    expect(page.map((r) => r.id)).toEqual(expected);
  });
});
