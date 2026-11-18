import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review B4 — the REVIEW claim is fenced on the job insert, in that insert's transaction.
 *
 * The commit-between-lookup-and-delete interleaving: a stale-claim sweep reads "no job for this claim" before the
 * dispatching pass has committed its insert, and then runs its conditional delete. Either the delete wins — the
 * claim is gone and the fence must roll the insert back, so no job exists that no claim owns — or the insert wins —
 * the claim is `dispatched` with the job id in the same commit, so the sweep's delete matches no row.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-review-claim-fence.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { PrismaFleetPrReviewRepository } from '../../../src/fleet/reviews/prisma-fleet-pr-review.repository';
import { ReviewClaimLostError } from '../../../src/fleet/reviews/review-claim-errors';
import type { DispatchFleetJobDto } from '../../../src/fleet/jobs/dto/dispatch-fleet-job.dto';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet REVIEW claim fence (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let jobs: FleetJobsService;
  let reviews: PrismaFleetPrReviewRepository;
  let projectId: string;
  let repoId: string;
  let adminId: string;

  const reviewDto = (prNumber: number): DispatchFleetJobDto => ({
    command: 'REVIEW', repoId, prNumber, profiles: [], maxCostUsd: 1, bashMode: 'raw', approvalTimeoutSec: 600,
  } as DispatchFleetJobDto);

  /** The fence the dispatcher passes: the claim link, aborted when the claim is no longer this pass's. */
  const fenceFor = (claimId: string) => async (jobId: string): Promise<void> => {
    const linked = await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => reviews.markDispatchedIfPending(claimId, jobId));
    if (!linked) throw new ReviewClaimLostError();
  };

  const claim = (prNumber: number) => withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
    db.fleetPrReview.create({ data: { repoId, prNumber, headSha: `sha-${prNumber}`, outcome: 'pending' } }));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const base = await seedFleetBase(db);
    ({ projectId, repoId, adminId } = base);
    jobs = app.get(FleetJobsService);
    reviews = new PrismaFleetPrReviewRepository(app.get(TRANSACTION_MANAGER), app.get(PrismaService));
  });

  afterAll(async () => { await app?.close(); });

  it('commits the job and its claim link together when the fence wins', async () => {
    const row = await claim(42);

    const result = await withTestActor({ type: 'USER', id: adminId }, () => jobs.dispatch(
      adminId, projectId, reviewDto(42), { auditKey: 'system.pr-review.dispatch', fence: fenceFor(row.id) },
    ));

    await expect(db.fleetPrReview.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ outcome: 'dispatched', jobId: result.job.id });
    await expect(db.fleetJob.findUnique({ where: { id: result.job.id } })).resolves.not.toBeNull();
  });

  it('inserts no job when the fence loses the claim to a stale removal', async () => {
    const row = await claim(43);
    // The sweep's conditional delete, landed between this pass's insert and its link write.
    await withTestActor({ type: 'SYSTEM', id: 'seed' }, () => reviews.removeStalePending(row.id, new Date(Date.now() + 60_000)));

    await expect(withTestActor({ type: 'USER', id: adminId }, () => jobs.dispatch(
      adminId, projectId, reviewDto(43), { auditKey: 'system.pr-review.dispatch', fence: fenceFor(row.id) },
    ))).rejects.toBeInstanceOf(ReviewClaimLostError);

    await expect(db.fleetJob.count({ where: { repoId, feature: 'review-pr-43' } })).resolves.toBe(0);
    await expect(db.fleetPrReview.findUnique({ where: { id: row.id } })).resolves.toBeNull();
  });

  it('leaves the claim settled by the winning insert when the sweep instead loses', async () => {
    const row = await claim(44);

    const result = await withTestActor({ type: 'USER', id: adminId }, () => jobs.dispatch(
      adminId, projectId, reviewDto(44), { auditKey: 'system.pr-review.dispatch', fence: fenceFor(row.id) },
    ));

    // The sweep that read "no job" before this commit cannot drop the claim once the insert has committed.
    await expect(withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
      reviews.removeStalePending(row.id, new Date(Date.now() + 60_000)))).resolves.toBe(false);
    await expect(db.fleetPrReview.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ outcome: 'dispatched', jobId: result.job.id });
  });
});
