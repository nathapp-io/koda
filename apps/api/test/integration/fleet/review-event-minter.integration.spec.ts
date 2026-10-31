import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { FleetReviewEventsService } from '../../../src/fleet/reviews/fleet-review-events.service';
import { ReviewEventMinter } from '../../../src/fleet/reviews/review-event.minter';
import { FleetReposService } from '../../../src/fleet/repos/fleet-repos.service';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('review event minter (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  beforeAll(async () => {
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app); base = await seedFleetBase(db);
  });
  afterAll(async () => { await app?.close(); });
  it('AC-14: bot-only pending event is durably skipped by the real event service', async () => {
    const job = await db.fleetJob.create({ data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'REVIEW', state: 'COMPLETED',
      feature: 'review-pr-42', profiles: [], selectorLabels: [], maxCostUsd: '5', requestedById: base.adminId,
    } });
    const row = await db.fleetReviewEvent.create({ data: {
      jobId: job.id, leaseEpoch: 1, projectId: base.projectId, repoId: base.repoId, prNumber: 42,
      findingKey: 'f-12345678', threadId: 'bot-thread', finding: 'finding', reason: 'reason',
      disagreedBy: ['dependabot[bot]'], trusted: true, status: 'pending',
    } });
    const repos = { findReviewRepo: vi.fn() };
    const minter = new ReviewEventMinter(app.get(FleetReviewEventsService), repos as never, {} as never, {} as never);
    await minter.run();
    expect(await db.fleetReviewEvent.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'skipped', skipReason: 'no-writer', attempts: 0 });
    expect(repos.findReviewRepo).not.toHaveBeenCalled();
  });
  it('AC-15: unknown review repo returns null', async () => {
    expect(await app.get(FleetReposService).findReviewRepo('unknown-review-repo')).toBeNull();
  });
});
