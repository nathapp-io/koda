import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';

const describeDb = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeDb('fleet system schedule audit (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const previousHooks = process.env.FLEET_TEST_HOOKS;
  const NOW = new Date('2026-10-02T03:00:30.000Z');
  const NEXT = new Date('2026-10-02T04:00:00.000Z');
  let n = 0;
  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) => prisma.jobSchedule.create({ data: {
    projectId: world.projectId, repoId: world.repoId, name: `system-schedule-${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `system-schedule-${n}`,
    ref: 'main', profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: new Date('2026-10-02T03:00:00.000Z'),
    createdById: world.ids.dev, updatedById: world.ids.dev, ...over,
  } });
  const rows = (id: string, key?: string) => prisma.auditEntry.findMany({ where: { resourceId: id, ...(key ? { key } : {}) } });
  const tick = () => withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => app.get(ScheduleTicker).tick(NOW));
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    process.env.FLEET_TEST_HOOKS = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
    if (previousHooks === undefined) delete process.env.FLEET_TEST_HOOKS;
    else process.env.FLEET_TEST_HOOKS = previousHooks;
  });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.fleetActivity.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.fleetCommand.deleteMany();
  });

  it('AC-1/2: scheduled dispatch is SYSTEM/schedule on behalf of the owner, without a second dispatch key', async () => {
    const s = await schedule();
    await tick();
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(await rows(job.id)).toMatchObject([{
      key: 'system.schedule.dispatch', resourceType: 'fleet-job', resourceId: job.id, projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'schedule', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'system',
      summary: `RUN on repo ${world.repoId}, schedule ${s.id}`,
    }]);
    expect(await rows(job.id, 'fleet.job.dispatch')).toHaveLength(0);
  });

  it('AC-3/4/9: coalesce audits only absorption; running jobs only add the skip activity', async () => {
    const s = await schedule();
    await tick();
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => app.get(ScheduleTicker).tick(new Date('2026-10-02T04:00:30.000Z')));
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: s.id } });
    expect(await rows(s.id, 'system.schedule.dispatch')).toMatchObject([{
      actorType: 'SYSTEM', actorId: 'schedule', onBehalfOfId: world.ids.dev, summary: `coalesced into job ${job.id}`,
    }]);
    const count = await rows(s.id, 'system.schedule.dispatch');
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'RUNNING' } });
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: new Date('2026-10-02T05:00:00.000Z') } });
    await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => app.get(ScheduleTicker).tick(new Date('2026-10-02T05:00:30.000Z')));
    expect(await rows(s.id, 'system.schedule.dispatch')).toHaveLength(count.length);
    expect(await prisma.fleetActivity.count({ where: { entityId: s.id, action: 'schedule.tick_skipped' } })).toBe(1);
  });

  it.each([
    ['lost owner permission', async () => { const user = await prisma.user.create({ data: { email: `lost-${++n}@koda.test`, passwordHash: 'x' } }); return schedule({ createdById: user.id }); }, 'owner_lost_access'],
    ['invalid cron', async () => schedule({ cron: 'not a cron' }), 'template_invalid'],
  ])('AC-5/6: auto-disable for %s has one attributed entry', async (_name, create, reason) => {
    const s = await create();
    await tick();
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(false);
    expect(await rows(s.id, 'system.schedule.dispatch')).toMatchObject([{
      actorType: 'SYSTEM', actorId: 'schedule', summary: `disabled: ${reason}`,
    }]);
  });

  it('AC-7/14: audit failure rolls back disable and coalesce state; ticker catches and continues', async () => {
    const owner = await prisma.user.create({ data: { email: `refused-owner-${++n}@koda.test`, passwordHash: 'x' } });
    const s = await schedule({ createdById: owner.id });
    const recorder = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    expect((await tick()).failed).toBe(1);
    recorder.mockRestore();
    expect((await prisma.jobSchedule.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(true);
    expect(await rows(s.id, 'system.schedule.dispatch')).toHaveLength(0);
    await prisma.jobSchedule.delete({ where: { id: s.id } });

    const queued = await schedule();
    await tick();
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: queued.id } });
    expect(job.coalescedCount).toBe(0);
    await prisma.jobSchedule.update({ where: { id: queued.id }, data: { nextFireAt: NEXT } });
    const failCoalesce = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const result = await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => app.get(ScheduleTicker).tick(new Date('2026-10-02T04:00:30.000Z')));
    failCoalesce.mockRestore();
    expect(result.failed).toBe(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).coalescedCount).toBe(0);
    expect(await rows(queued.id, 'system.schedule.dispatch')).toHaveLength(0);
  });

  it('AC-8/9/10/11/12: hook audits caller only on an enabled known schedule and preserves refusal statuses', async () => {
    const s = await schedule();
    const fire = (id: string) => request(server).post(`/api/fleet/test-hooks/schedules/${id}/fire`).set(auth('root'));
    const before = await prisma.auditEntry.count({ where: { key: 'testhook.schedule.fire' } });
    await fire('missing-schedule').expect(404);
    expect(await prisma.auditEntry.count({ where: { key: 'testhook.schedule.fire' } })).toBe(before);
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { enabled: false, disabledReason: 'manual' } });
    await fire(s.id).expect(409);
    expect(await rows(s.id, 'testhook.schedule.fire')).toHaveLength(0);
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { enabled: true, disabledReason: null } });
    await fire(s.id).expect(200);
    expect(await rows(s.id, 'testhook.schedule.fire')).toMatchObject([{
      actorType: 'USER', actorId: world.ids.root, origin: 'rest', resourceType: 'fleet-schedule', summary: 'fired',
    }]);
  });

  it('AC-9: a fire-hook coalesce attributes the schedule audit to SYSTEM/schedule, not its caller', async () => {
    const s = await schedule();
    await tick();
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { scheduleId: s.id } });
    await prisma.jobSchedule.update({ where: { id: s.id }, data: { nextFireAt: NEXT } });
    await request(server).post(`/api/fleet/test-hooks/schedules/${s.id}/fire`).set(auth('root')).expect(200);
    expect(await rows(s.id, 'system.schedule.dispatch')).toMatchObject([{
      actorType: 'SYSTEM', actorId: 'schedule', onBehalfOfId: world.ids.dev, summary: `coalesced into job ${job.id}`,
    }]);
  });

  it('AC-10: disabled test hooks return 404 without recording', async () => {
    const s = await schedule();
    const previous = process.env.FLEET_TEST_HOOKS;
    process.env.FLEET_TEST_HOOKS = 'false';
    // Config is cached at application boot; restore it even when the request/assertion fails.
    const config = app.get<IFleetConfig>(FLEET_CFG);
    const wasEnabled = config.testHooksEnabled;
    try {
      config.testHooksEnabled = false;
      await request(server).post(`/api/fleet/test-hooks/schedules/${s.id}/fire`).set(auth('root')).expect(404);
      expect(await rows(s.id, 'testhook.schedule.fire')).toHaveLength(0);
    } finally {
      config.testHooksEnabled = wasEnabled;
      if (previous === undefined) delete process.env.FLEET_TEST_HOOKS;
      else process.env.FLEET_TEST_HOOKS = previous;
    }
  });

  it('AC-13: manual dispatch retains fleet.job.dispatch and never uses the system schedule key', async () => {
    const response = await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev')).send({
      repoId: world.repoId, command: 'RUN', feature: `manual-audit-${++n}`, ref: 'main', profiles: [], maxCostUsd: 5,
    }).expect(201);
    const job = data<{ job: { id: string } }>(response).job;
    expect(await rows(job.id, 'fleet.job.dispatch')).toHaveLength(1);
    expect(await rows(job.id, 'system.schedule.dispatch')).toHaveLength(0);
  });
});
