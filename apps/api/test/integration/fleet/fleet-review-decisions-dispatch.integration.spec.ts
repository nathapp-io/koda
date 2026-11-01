import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, type FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { ReviewDecisionsService } from '../../../src/memory/review-decisions.service';
import type { FleetJobDto } from '../../../src/fleet/jobs/dto/fleet-job.dto';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('review decisions dispatch snapshot (PG)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  const decisions = [{ id: 'm1', statement: 'auth: tokens live in Redis', source: 'koda:memory/m1' }];
  const auth = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const route = '/api/projects/web/fleet/jobs';
  const dispatch = (prNumber = 42) => request(app.getHttpServer()).post(route).set(auth())
    .send({ command: 'REVIEW', repoId: world.repoId, prNumber, maxCostUsd: 1, profiles: ['fast'] });
  const seed = () => db.memoryItem.create({ data: {
    id: 'm1', projectId: world.projectId, kind: 'DECISION', subject: 'general', predicate: 'auth',
    object: 'tokens live in Redis', status: 'active', confidence: 0.8, sourceType: 'decision_event',
  } });
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 60000);
  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.fleetCommand.deleteMany();
    await db.fleetJob.deleteMany();
    await db.runner.deleteMany();
    await db.memoryItem.deleteMany();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('AC-1 stores the selected wire-format snapshot', async () => {
    await seed();
    const { job } = data<{ job: FleetJobDto }>(await dispatch().expect(201));
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).reviewDecisions).toEqual(decisions);
  });
  it('AC-2 stores [] when there are no active decisions', async () => {
    const { job } = data<{ job: FleetJobDto }>(await dispatch(43).expect(201));
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).reviewDecisions).toEqual([]);
  });
  it('AC-3 stores null for RUN even with active decisions', async () => {
    await seed();
    const { job } = data<{ job: FleetJobDto }>(await request(app.getHttpServer()).post(route).set(auth())
      .send({ command: 'RUN', repoId: world.repoId, feature: 'f', maxCostUsd: 1 }).expect(201));
    expect((await db.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).reviewDecisions).toBeNull();
  });
  it('AC-4 sends the stored snapshot in ASSIGN to an online review runner', async () => {
    await seed();
    await insertRunner(db, { capabilities: { ...FLEET_CAPS, botReview: true } });
    const { job } = data<{ job: FleetJobDto }>(await dispatch().expect(201));
    expect(job.state).toBe('ASSIGNED');
    const command = await db.fleetCommand.findFirstOrThrow({ where: { jobId: job.id, type: 'ASSIGN' } });
    expect(command.payload).toHaveProperty('review.decisions', decisions);
  });
  it('AC-5 exposes the dispatch snapshot in detail', async () => {
    await seed();
    const { job } = data<{ job: FleetJobDto }>(await dispatch().expect(201));
    await db.memoryItem.update({ where: { id: 'm1' }, data: { object: 'changed after dispatch' } });
    const detail = data<FleetJobDto>(await request(app.getHttpServer()).get(`${route}/${job.id}`).set(auth()).expect(200));
    expect(detail.reviewDecisions).toEqual(decisions);
  });
  it('AC-6 hides the snapshot on list pages', async () => {
    await seed();
    const { job } = data<{ job: FleetJobDto }>(await dispatch().expect(201));
    const list = data<{ records: FleetJobDto[] }>(await request(app.getHttpServer()).get(route).set(auth()).expect(200));
    expect(list.records.find((r) => r.id === job.id)).toHaveProperty('reviewDecisions', null);
  });
  it('AC-15 returns 500 and inserts nothing when selection fails', async () => {
    vi.spyOn(app.get(ReviewDecisionsService), 'selectForReview').mockRejectedValue(new Error('memory query failed'));
    await dispatch().expect(500);
    expect(await db.fleetJob.count()).toBe(0);
  });
});
