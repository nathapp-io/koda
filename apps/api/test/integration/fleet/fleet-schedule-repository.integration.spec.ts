/**
 * Fleet S1b slice 3a — PrismaScheduleRepository on PG: CAS claim, atomic coalesce, counted claim, owner access.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schedule-repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import type { NewSchedule } from '../../../src/fleet/schedules/domain/schedule.domain';
import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

vi.setConfig({ testTimeout: 20_000 });

describeIntegration('schedule repository (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let repo: PrismaScheduleRepository;
  let base: Awaited<ReturnType<typeof seedFleetBase>>;
  let n = 0;
  const NOW = new Date('2026-10-02T03:00:30.000Z');
  const DUE = new Date('2026-10-02T03:00:00.000Z');

  const make = (over: Partial<NewSchedule> = {}) => repo.create({
    projectId: base.projectId, repoId: base.repoId, name: `s${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `rf${n}`,
    ref: 'main', profiles: [], maxCostUsd: '5', selectorLabels: [], bashMode: 'raw', approvalTimeoutSec: 600,
    pinnedRunnerId: null, noProgressLimit: 3,
    nextFireAt: DUE, createdById: base.adminId, ...over,
  });
  const job = (scheduleId: string | null, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => prisma.fleetJob.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature: `rj${++n}`, profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: base.adminId, scheduleId, ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    repo = app.get(PrismaScheduleRepository);
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
  });

  it('round-trips a schedule with the decimal as a string and the creator as updater', async () => {
    const s = await make({ maxCostUsd: '5.5' });
    expect(await repo.findById(s.id)).toEqual(expect.objectContaining({
      id: s.id, maxCostUsd: '5.5', updatedById: base.adminId, enabled: true, disabledReason: null, nextFireAt: DUE,
    }));
    expect(await repo.findById('nope')).toBeNull();
  });

  it('findDue: enabled and due only, oldest first, capped, and never a soft-deleted project (plan D207)', async () => {
    const late = await make({ nextFireAt: new Date('2026-10-02T03:00:10.000Z') });
    const early = await make({ nextFireAt: new Date('2026-10-02T02:00:00.000Z') });
    await make({ nextFireAt: new Date('2026-10-02T09:00:00.000Z') });
    const off = await make({ nextFireAt: DUE });
    await repo.update(off.id, { enabled: false, disabledReason: 'manual' });
    const gone = await prisma.project.create({ data: { name: 'gone', slug: 'gone-p', key: 'GONEP', deletedAt: new Date() } });
    await make({ projectId: gone.id, nextFireAt: DUE });

    expect((await repo.findDue(NOW, 10)).map((s) => s.id)).toEqual([early.id, late.id]);
    expect((await repo.findDue(NOW, 1)).map((s) => s.id)).toEqual([early.id]);
  });

  it('claimFire moves nextFireAt once: a second claim of the same value, or of a disabled schedule, loses', async () => {
    const s = await make();
    const next = new Date('2026-10-02T04:00:00.000Z');
    expect(await repo.claimFire(s.id, DUE, next, NOW)).toBe(true);
    expect(await repo.claimFire(s.id, DUE, next, NOW)).toBe(false);
    expect(await repo.findById(s.id)).toEqual(expect.objectContaining({ nextFireAt: next, lastFiredAt: NOW }));
    await repo.update(s.id, { enabled: false, disabledReason: 'manual' });
    expect(await repo.claimFire(s.id, next, new Date('2026-10-02T05:00:00.000Z'), NOW)).toBe(false);
  });

  it('claimFire under two concurrent callers has exactly one winner', async () => {
    const s = await make();
    const next = new Date('2026-10-02T04:00:00.000Z');
    const wins = await Promise.all([repo.claimFire(s.id, DUE, next, NOW), repo.claimFire(s.id, DUE, next, NOW)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('findActiveJob returns the newest active job and ignores finished ones', async () => {
    const s = await make();
    expect(await repo.findActiveJob(s.id)).toBeNull();
    await job(s.id, { state: 'FAILED' });
    expect(await repo.findActiveJob(s.id)).toBeNull();
    const running = await job(s.id, { state: 'RUNNING' });
    expect(await repo.findActiveJob(s.id)).toEqual({ id: running.id, state: 'RUNNING' });
  });

  it('coalesceIntoQueued adds one to the QUEUED job atomically and does nothing for any other state (plan D200)', async () => {
    const s = await make();
    const queued = await job(s.id, { state: 'QUEUED' });
    expect(await repo.coalesceIntoQueued(s.id)).toBe(queued.id);
    expect(await repo.coalesceIntoQueued(s.id)).toBe(queued.id);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).coalescedCount).toBe(2);
    await prisma.fleetJob.update({ where: { id: queued.id }, data: { state: 'ASSIGNED' } });
    expect(await repo.coalesceIntoQueued(s.id)).toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: queued.id } })).coalescedCount).toBe(2);
  });

  it('claimCounted succeeds once per job (plan D196)', async () => {
    const s = await make();
    const j = await job(s.id, { state: 'FAILED' });
    const wins = await Promise.all([repo.claimCounted(j.id, NOW), repo.claimCounted(j.id, NOW)]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleCountedAt).toEqual(NOW);
    expect(await repo.claimCounted(j.id, NOW)).toBe(false);
  });

  it('findOwnerAccess reports a missing user, a disabled user, and the project role', async () => {
    expect(await repo.findOwnerAccess(base.projectId, 'no-such-user')).toEqual({ exists: false, disabled: false, globalRole: '', projectRole: null });
    const off = await prisma.user.create({ data: { email: 'off@koda.test', passwordHash: 'x', role: 'MEMBER', disabled: true } });
    expect(await repo.findOwnerAccess(base.projectId, off.id)).toEqual({ exists: true, disabled: true, globalRole: 'MEMBER', projectRole: null });
    const dev = await prisma.user.create({ data: { email: 'dev-access@koda.test', passwordHash: 'x', role: 'MEMBER' } });
    await prisma.projectMember.create({ data: { projectId: base.projectId, userId: dev.id, role: 'DEVELOPER' } });
    expect(await repo.findOwnerAccess(base.projectId, dev.id)).toEqual({ exists: true, disabled: false, globalRole: 'MEMBER', projectRole: 'DEVELOPER' });
    expect(await repo.findOwnerAccess(base.projectId, base.adminId)).toEqual({ exists: true, disabled: false, globalRole: 'ADMIN', projectRole: null });
  });

  it('delete detaches the schedule\'s jobs and keeps them (plan D194)', async () => {
    const s = await make();
    const j = await job(s.id, { state: 'FAILED' });
    await repo.delete(s.id);
    expect(await repo.findById(s.id)).toBeNull();
    expect((await prisma.fleetJob.findUniqueOrThrow({ where: { id: j.id } })).scheduleId).toBeNull();
  });

  it('sumCostBySchedule adds spent and carried cost per schedule; a schedule with no jobs is absent', async () => {
    const a = await make();
    const b = await make();
    await job(a.id, { state: 'FAILED', costSpentUsd: new Prisma.Decimal('1.25'), costCarriedUsd: new Prisma.Decimal('0.5') });
    await job(a.id, { state: 'COMPLETED', costSpentUsd: new Prisma.Decimal('2') });
    expect(await repo.sumCostBySchedule([a.id, b.id])).toEqual(new Map([[a.id, '3.7500']]));
    expect(await repo.sumCostBySchedule([])).toEqual(new Map());
  });

  it('lockById returns the record inside a transaction and null for an unknown id', async () => {
    const s = await make();
    expect((await repo.lockById(s.id))?.id).toBe(s.id);
    expect(await repo.lockById('nope')).toBeNull();
  });
});
