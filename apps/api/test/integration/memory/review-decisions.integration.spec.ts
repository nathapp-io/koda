import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ReviewDecisionsService } from '../../../src/memory/review-decisions.service';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('ReviewDecisionsService selection (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let sequence = 0;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 60000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => { await db.memoryItem.deleteMany(); sequence = 0; });

  const insert = (projectId = world.projectId, values: Record<string, unknown> = {}) => db.memoryItem.create({ data: {
    projectId, kind: 'DECISION', subject: 'general', predicate: `decision-${++sequence}`, object: 'settled',
    status: 'active', confidence: 0.8, ...values,
  } });
  const select = () => app.get(ReviewDecisionsService).selectForReview(world.projectId, 'R1');

  it('AC-1/2/3/4/5/6/7/8/9/10/11: selects only eligible project and repo decisions', async () => {
    const eligible = await insert(world.projectId, { sourceType: 'decision_event' });
    const nullable = await insert(world.projectId, { sourceType: null });
    const otherProject = await insert(world.opsProjectId, { sourceType: 'decision_event' });
    const otherRepoProject = await insert(world.opsProjectId, { sourceType: 'review_event', subject: 'repo:R1' });
    await insert(world.projectId, { status: 'superseded' });
    await insert(world.projectId, { status: 'rejected' });
    await insert(world.projectId, { deletedAt: new Date() });
    await insert(world.projectId, { ttlAt: new Date(Date.now() - 3600000) });
    await insert(world.projectId, { kind: 'FACT' });
    const review = await insert(world.projectId, { sourceType: 'review_event', subject: 'repo:R1' });
    const otherRepo = await insert(world.projectId, { sourceType: 'review_event', subject: 'repo:R2' });
    const ids = (await select()).map((decision) => decision.id);
    expect(ids).toContain(eligible.id);
    expect(ids).toContain(nullable.id);
    expect(ids).toContain(review.id);
    expect(ids).not.toContain(otherProject.id);
    expect(ids).not.toContain(otherRepoProject.id);
    expect(ids).not.toContain(otherRepo.id);
    expect(ids).toHaveLength(3);
  });

  it('AC-12/13: orders within groups and prioritizes recorded decisions', async () => {
    const old = await insert(world.projectId, { predicate: 'old', updatedAt: new Date('2025-01-01T10:00:00Z') });
    const recent = await insert(world.projectId, { predicate: 'recent', updatedAt: new Date('2025-01-01T11:00:00Z') });
    const newestReview = await insert(world.projectId, { sourceType: 'review_event', subject: 'repo:R1', updatedAt: new Date('2025-01-01T12:00:00Z') });
    const ids = (await select()).map((decision) => decision.id);
    expect(ids.slice(0, 2)).toEqual([recent.id, old.id]);
    expect(ids[0]).not.toBe(newestReview.id);
  });

  it('AC-14: caps the combined selection at 100 recorded decisions', async () => {
    await db.memoryItem.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      projectId: world.projectId, kind: 'DECISION', subject: 'general', predicate: `cap-${i}`, status: 'active', confidence: 0.8,
    })) });
    expect(await select()).toHaveLength(100);
  });
});
