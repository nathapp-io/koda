import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { seedFleetHttpWorld, insertRunner, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('fleet job transactional audit HTTP', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;
  const url = '/api/projects/web/fleet/jobs';
  const auth = (who: 'dev' | 'viewer' = 'dev') => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const dispatch = (feature: string, who: 'dev' | 'viewer' = 'dev') => request(app.getHttpServer()).post(url).set(auth(who)).send({ repoId: world.repoId, feature, command: 'RUN', maxCostUsd: 5 });
  const entries = (key: string, resourceId?: string) => db.auditEntry.findMany({ where: { key, projectId: world.projectId, ...(resourceId ? { resourceId } : {}) }, take: 100 });
  const newJob = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => db.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `fixture-${++seq}`, profiles: [],
    maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: world.ids.dev, state: 'QUEUED', ...over,
  } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 60_000);
  beforeEach(() => resetThrottle(app));
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); });

  it('AC-1/2: attributes one committed dispatch, not its duplicate', async () => {
    const feature = `dispatch-${++seq}`;
    const before = (await entries('fleet.job.dispatch')).length;
    const created = data<{ job: { id: string } }>(await dispatch(feature).expect(201)).job;
    expect(await entries('fleet.job.dispatch', created.id)).toEqual([expect.objectContaining({
      key: 'fleet.job.dispatch', resourceType: 'fleet-job', resourceId: created.id, projectId: world.projectId,
      actorType: 'USER', actorId: world.ids.dev, origin: 'rest', summary: `RUN on repo ${world.repoId}`,
    })]);
    await dispatch(feature).expect(409);
    expect((await entries('fleet.job.dispatch')).length).toBe(before + 1);
  });

  it('AC-3: refused dispatch records nothing', async () => {
    const before = await entries('fleet.job.dispatch');
    await dispatch(`refused-${++seq}`, 'viewer').expect(403);
    expect(await entries('fleet.job.dispatch')).toEqual(before);
  });

  it('AC-6: recorder rejection rolls back the inserted job', async () => {
    const feature = `rollback-${++seq}`;
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const response = await dispatch(feature);
    expect(response.status).toBe(500);
    expect(await db.fleetJob.count({ where: { repoId: world.repoId, feature } })).toBe(0);
  });

  it('AC-7: cancels QUEUED with its previous state', async () => {
    const job = await newJob();
    await request(app.getHttpServer()).post(`${url}/${job.id}/cancel`).set(auth()).expect(200);
    expect(await entries('fleet.job.cancel', job.id)).toEqual([expect.objectContaining({ summary: 'cancelled from QUEUED' })]);
  });

  it('AC-8/9: requests RUNNING cancellation only once after assign acknowledgment', async () => {
    const runner = await insertRunner(db, { enabled: false, createdById: world.ids.root });
    const job = await newJob({ state: 'RUNNING', runnerId: runner.id, leaseEpoch: 1 });
    await db.fleetCommand.create({ data: { runnerId: runner.id, jobId: job.id, type: 'ASSIGN', leaseEpoch: 1, payload: {}, ackedAt: new Date() } });
    for (let i = 0; i < 2; i++) {
      await request(app.getHttpServer()).post(`${url}/${job.id}/cancel`).set(auth()).expect(200);
      expect(await entries('fleet.job.cancel', job.id)).toEqual([expect.objectContaining({ summary: 'cancel requested in RUNNING' })]);
    }
  });

  it('AC-10: requeues FAILED with its previous state', async () => {
    const job = await newJob({ state: 'FAILED', finishedAt: new Date() });
    await request(app.getHttpServer()).post(`${url}/${job.id}/requeue`).set(auth()).expect(200);
    expect(await entries('fleet.job.requeue', job.id)).toEqual([expect.objectContaining({ summary: 'requeued from FAILED' })]);
  });

  it.each([true, false])('AC-11/12: unlink records only an existing link (%s)', async (linked) => {
    const ticket = await db.ticket.create({ data: { projectId: world.projectId, number: ++seq, title: 'Private', type: 'TASK', status: 'IN_PROGRESS' } });
    const job = await newJob();
    if (linked) await db.fleetJobTicket.create({ data: { ticketId: ticket.id, jobId: job.id } });
    await request(app.getHttpServer()).delete(`/api/projects/web/tickets/WEB-${ticket.number}/fleet-jobs/${job.id}`).set(auth()).expect(linked ? 204 : 404);
    expect(await entries('fleet.ticket-job.unlink', ticket.id)).toEqual(linked ? [expect.objectContaining({ resourceType: 'ticket', summary: `job ${job.id} unlinked` })] : []);
  });
});
