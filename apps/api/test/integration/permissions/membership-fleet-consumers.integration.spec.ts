/**
 * Permissions P1b US-004 — fleet activity scoping and schedule owners read the compatibility union
 * (AC-1 .. AC-6), over real HTTP, the real ticker and real Postgres.
 *
 * Every principal here has exactly one kind of source in the project under test, so an AC passes only
 * when the reader consults the access sources: `PermissionService.projectIdsWithKey`
 * (reached through `GET /fleet/activity` and `GET /fleet/approval-counts`) and
 * `PrismaScheduleRepository.findOwnerAccess` (reached through `POST /projects/:slug/fleet/schedules/:id/enable`
 * and `ScheduleTicker.tick`) on one side, and the compatibility queries in
 * `src/permissions/membership.queries.ts` on the other. Sources are real rows — bindings
 * through `MembershipService.createBinding` (booting the app runs `SystemRoleSeeder`, so the seeded
 * role keys exist), no legacy `ProjectMember` row anywhere in this spec.
 *
 * The enable caller is the installation's global admin, distinct from the binding-only schedule
 * owner: `enable` validates the **owner's** role, so a caller whose own project role came from a
 * binding would make this spec depend on US-002.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/membership-fleet-consumers.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';
import { mayDispatch } from '../../../src/fleet/schedules/schedule-access';
import { MembershipService } from '../../../src/permissions/membership.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

/** Booting `AppModule` runs the system-role seeder, so the first hook needs a generous budget. */
const BOOT_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;

const P1_SLUG = 'p1';
const P2_SLUG = 'p2';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only, so a slug-derived `P1` would be a 400. */
const P1_KEY = 'PONE';
const P2_KEY = 'PTWO';

/** The English sentence of `fleet.scheduleOwnerNoAccess` at HTTP 409, read from the catalog. */
const OWNER_NO_ACCESS = (
  JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en/fleet.json'), 'utf8')) as {
    scheduleOwnerNoAccess: Record<string, string>;
  }
).scheduleOwnerNoAccess['409'];

/**
 * The envelope's error-code field (`ret`) of that refusal: `SchedulesService.enable` throws the 409
 * `ConflictAppException`, whose code is 409 and whose i18n coordinate is `fleet.scheduleOwnerNoAccess`.
 */
const SCHEDULE_OWNER_NO_ACCESS_CODE = 409;

/** The ticker's fixed clock: a minute past the top of the hour the cron below fires on. */
const NOW = new Date('2026-10-02T03:00:30.000Z');
const DUE = new Date('2026-10-02T03:00:00.000Z');

interface ActivityItem {
  id: string;
  projectId: string | null;
}
interface ApprovalCounts {
  total: number;
  unscoped: number;
  projects: Array<{ projectId: string; slug: string; pending: number }>;
}
interface ScheduleItem {
  id: string;
  enabled: boolean;
  disabledReason: string | null;
}

describeIntegration('fleet consumers read bindings (US-004, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let permissions: PermissionService;
  let ticker: ScheduleTicker;
  let repo: PrismaScheduleRepository;

  let rootToken = '';
  let p1Id = '';
  let p2Id = '';
  let p1RepoId = '';
  let n = 0;
  const ids: Record<string, string> = {};

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  const userPrincipal = (who: string): PrincipalRef => ({ type: 'USER', id: ids[who] });
  /** US-005: the owner's own effective keys in p1, which `mayDispatch` combines with its existence. */
  const keysOf = (who: string) => permissions.effectiveKeys(userPrincipal(who), { projectId: p1Id });
  const bind = (principal: PrincipalRef, roleKey: string, projectId: string) =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
      membership.createBinding({ principal, roleKey, projectId }, { type: 'USER', id: ids.root }));

  /** A MEMBER-role user with a working account; registration is closed, so it goes through the admin route. */
  const createUser = async (who: string): Promise<string> => {
    resetThrottle(app);
    const created = await request(server).post('/api/admin/users').set(as(rootToken))
      .send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' })
      .expect(201);
    return data<{ id: string }>(created).id;
  };

  /**
   * The principal's **access sources from bindings**: the PROJECT-scope bindings it holds, in the
   * project and `projectId`-null. A GLOBAL-scope binding is never a source — the admin create route
   * writes one as a baseline for every user — so this is the list the reader must answer from.
   */
  const projectBindingsOf = (userId: string) =>
    prisma.roleBinding.findMany({
      where: { principalType: 'USER', principalId: userId, role: { scope: 'PROJECT' } },
      select: { projectId: true, role: { select: { key: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  /** The ACs' premise: no legacy `ProjectMember` row, and the only project binding is the one named. */
  const expectOnlyProjectBinding = async (userId: string, projectId: string, roleKey: string): Promise<void> => {

    expect(await projectBindingsOf(userId)).toEqual([{ projectId, role: { key: roleKey } }]);
  };

  const activityRow = (projectId: string, action: string) =>
    prisma.fleetActivity.create({
      data: {
        actorType: 'USER', actorId: ids.root, action, entityType: 'job', entityId: `e${++n}`,
        projectId, responsibleUserId: ids.root, payload: {},
      },
    });

  const approvalRow = (projectId: string) =>
    prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', status: 'pending', projectId, payload: {}, requestedAt: DUE },
    });

  const schedule = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) =>
    prisma.jobSchedule.create({
      data: {
        projectId: p1Id, repoId: p1RepoId, name: `s${++n}`, cron: '0 * * * *', timezone: 'UTC', feature: `f${n}`, ref: 'trunk',
        profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: DUE,
        createdById: ids.devBind, updatedById: ids.root, ...over,
      },
    });

  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    membership = app.get(MembershipService);
    permissions = app.get(PermissionService);
    ticker = app.get(ScheduleTicker);
    repo = app.get(PrismaScheduleRepository);

    // The bootstrap registration: the first user is the installation Owner, so it is a global ADMIN.
    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    rootToken = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const [slug, key] of [[P1_SLUG, P1_KEY], [P2_SLUG, P2_KEY]] as const) {
      await request(server).post('/api/projects').set(as(rootToken))
        .send({ name: `Project ${slug}`, slug, key }).expect(201);
    }
    p1Id = (await prisma.project.findUniqueOrThrow({ where: { slug: P1_SLUG } })).id;
    p2Id = (await prisma.project.findUniqueOrThrow({ where: { slug: P2_SLUG } })).id;

    for (const who of ['devBind', 'viewerOwner']) ids[who] = await createUser(who);
    for (const who of ['devBind', 'viewerOwner']) {
      resetThrottle(app);
      ids[`${who}Token`] = await loginToken(server, `${who}@koda.test`);
    }

    const fleetRepo = (projectId: string, name: string) => prisma.fleetRepo.create({
      data: {
        projectId, provider: 'github', owner: 'acme', name, defaultBranch: 'trunk',
        githubInstallationId: BigInt(77), createdById: ids.root,
      },
    });
    p1RepoId = (await fleetRepo(p1Id, 'p1-app')).id;
    await fleetRepo(p2Id, 'p2-app');

    await Promise.all([
      bind(userPrincipal('devBind'), 'developer', p1Id),
      bind(userPrincipal('viewerOwner'), 'viewer', p1Id),
    ]);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    // The tick tests need an empty fleet world: no other due schedule, no job in an active state and no
    // paused budget (which would skip the tick instead of dispatching). The rows a test creates are its own.
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetActivity.deleteMany();
    await prisma.fleetApproval.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: a user whose only source in p1 is a developer binding sees p1\'s activity and not p2\'s', async () => {
    await expectOnlyProjectBinding(ids.devBind, p1Id, 'developer');
    const inP1 = await activityRow(p1Id, 'job.dispatched');
    const inP2 = await activityRow(p2Id, 'job.dispatched');

    const mine = await request(server).get('/api/fleet/activity?size=100').set(as(ids.devBindToken)).expect(200);
    const mineIds = data<{ records: ActivityItem[] }>(mine).records.map((row) => row.id);

    expect(mineIds).toContain(inP1.id);
    expect(mineIds).not.toContain(inP2.id);
    // The p2 row is not invisible to everyone: the same request as the global admin carries both,
    // so the assertion above is about the caller's scope, not about a row that was never written.
    const all = await request(server).get('/api/fleet/activity?size=100').set(as(rootToken)).expect(200);
    const allIds = data<{ records: ActivityItem[] }>(all).records.map((row) => row.id);
    expect(allIds).toEqual(expect.arrayContaining([inP1.id, inP2.id]));
    expect(await prisma.fleetActivity.count({ where: { id: inP2.id } })).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('AC-2: a user whose only source in p1 is a developer binding counts p1\'s pending approvals only', async () => {
    await expectOnlyProjectBinding(ids.devBind, p1Id, 'developer');
    await Promise.all([approvalRow(p1Id), approvalRow(p1Id), approvalRow(p2Id)]);

    const res = await request(server).get('/api/fleet/approval-counts').set(as(ids.devBindToken)).expect(200);
    const counts = data<ApprovalCounts>(res);

    expect(counts.projects).toEqual([{ projectId: p1Id, slug: P1_SLUG, pending: 2 }]);
    expect(counts.total).toBe(2);
    expect(counts.unscoped).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('AC-3: a disabled schedule whose owner has only a developer binding is enabled', async () => {
    await expectOnlyProjectBinding(ids.devBind, p1Id, 'developer');
    const disabled = await schedule({ createdById: ids.devBind, enabled: false, disabledReason: 'manual' });

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/fleet/schedules/${disabled.id}/enable`)
      .set(as(rootToken)).expect(200);

    expect(data<ScheduleItem>(res).enabled).toBe(true);
    expect(await reload(disabled.id)).toEqual(expect.objectContaining({
      enabled: true, disabledReason: null, noProgressTicks: 0,
    }));
  }, TEST_TIMEOUT_MS);

  it('AC-4: a disabled schedule whose owner has only a viewer binding is refused with fleet.scheduleOwnerNoAccess', async () => {
    await expectOnlyProjectBinding(ids.viewerOwner, p1Id, 'viewer');
    const disabled = await schedule({ createdById: ids.viewerOwner, enabled: false, disabledReason: 'manual' });

    const res = await request(server)
      .post(`/api/projects/${P1_SLUG}/fleet/schedules/${disabled.id}/enable`)
      .set(as(rootToken)).expect(409);

    // The structured code, not only the prose: `fleet.scheduleOwnerNoAccess` is the i18n coordinate the
    // service throws, `ConflictAppException` carries code 409 (the envelope's `ret`) and the body's
    // message is the translation of `fleet.scheduleOwnerNoAccess.409` — read from the catalog above.
    const body = res.body as { ret: number; message: string };
    expect(body.ret).toBe(SCHEDULE_OWNER_NO_ACCESS_CODE);
    expect(body.message).toBe(OWNER_NO_ACCESS);
    expect(await reload(disabled.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual' }));
  }, TEST_TIMEOUT_MS);

  it('AC-5: a due schedule whose owner has only a developer binding dispatches a job', async () => {
    await expectOnlyProjectBinding(ids.devBind, p1Id, 'developer');
    const due = await schedule({ createdById: ids.devBind, feature: 'us004-dispatched' });

    // A timer round as `runOnce` runs it: the ticker is the `schedule` system component.
    expect(await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => ticker.tick(NOW)))
      .toEqual(expect.objectContaining({ claimed: 1, dispatched: 1, disabled: 0 }));

    const jobs = await prisma.fleetJob.findMany({ where: { scheduleId: due.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({
      command: 'RUN', feature: 'us004-dispatched', state: 'QUEUED', projectId: p1Id, requestedById: ids.devBind,
    }));
    expect(await reload(due.id)).toEqual(expect.objectContaining({ enabled: true, lastJobId: jobs[0]?.id }));
    // US-005: the owner's existence and its own effective keys are what `mayDispatch` combines.
    expect(mayDispatch(await repo.findOwnerAccess(p1Id, userPrincipal('devBind')), await keysOf('devBind'))).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('AC-6: a due schedule whose owner has only a viewer binding dispatches nothing and disables with owner_lost_access', async () => {
    await expectOnlyProjectBinding(ids.viewerOwner, p1Id, 'viewer');
    const due = await schedule({ createdById: ids.viewerOwner, feature: 'us004-refused' });

    expect(await withTestActor({ type: 'SYSTEM', id: 'schedule' }, () => ticker.tick(NOW)))
      .toEqual(expect.objectContaining({ claimed: 1, dispatched: 0, disabled: 1 }));

    expect(await prisma.fleetJob.count({ where: { scheduleId: due.id } })).toBe(0);
    expect(await reload(due.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    // A viewer binding's keys do not include fleet.job.dispatch, whatever the binding-derived role read.
    expect(mayDispatch(await repo.findOwnerAccess(p1Id, userPrincipal('viewerOwner')), await keysOf('viewerOwner'))).toBe(false);
  }, TEST_TIMEOUT_MS);
});
