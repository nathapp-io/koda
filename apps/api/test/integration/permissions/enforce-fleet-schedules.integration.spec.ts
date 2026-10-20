/**
 * Permissions P1d US-005 — the fleet schedule routes decide with catalog keys, the row owner keeps
 * `fleet.schedule.update`/`.delete` as `.own` keys, and a fire or an enable rechecks the **owner's**
 * `fleet.job.dispatch` over real HTTP, the real ticker and real Postgres (AC-1 .. AC-20, AC-25, AC-26).
 *
 * Every caller below has exactly one kind of source in `p1`: one PROJECT-scope binding (users, no
 * `ProjectMember` row anywhere) or one legacy `AgentProject` roster row plus `AgentRoleEntry` roles
 * (agents). No test asserts through a bypass: the refusals are the routes' and the ticker's own.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/enforce-fleet-schedules.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { ScheduleTicker } from '../../../src/fleet/schedules/schedule-ticker';
import { MembershipService } from '../../../src/permissions/membership.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;
/** `fleet.scheduleOwnerNoAccess.409`, the enable refusal whose code the AC names. */
const OWNER_NO_ACCESS = (readI18n('fleet')['scheduleOwnerNoAccess'] as Record<string, string>)['409'] as string;

/** The ticker's fixed clock: a minute past the top of the hour the fixtures' cron fires on. */
const NOW = new Date('2026-10-02T03:00:30.000Z');
const DUE = new Date('2026-10-02T03:00:00.000Z');

interface ScheduleItem {
  id: string;
  name: string;
  enabled: boolean;
  disabledReason: string | null;
}

describeIntegration('fleet schedule keys and ownership (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let ticker: ScheduleTicker;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let repoId = '';
  let n = 0;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };
  const as = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth(who));
    return body === undefined ? req : req.send(body);
  };
  const schedulesUrl = (suffix = '') => `/api/projects/${P1_SLUG}/fleet/schedules${suffix}`;

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    resetThrottle(app);
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    ids[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: string): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: ids[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    );

  /** A roster-only agent: its one key source in p1 is the roster row plus its `AgentRoleEntry` roles. */
  const createAgent = async (slug: string): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug, roles: ['DEVELOPER'] }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    await prisma.agentProject.create({ data: { agentId: body.agent.id, projectId: p1Id } });
    tokens[slug] = body.apiKey;
    // The rows are written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** A schedule row of p1, owned by `createdById` (a user by default). */
  const scheduleRow = (over: Partial<Prisma.JobScheduleUncheckedCreateInput> = {}) =>
    prisma.jobSchedule.create({
      data: {
        projectId: p1Id, repoId, name: `s${(n += 1)}`, cron: '0 * * * *', timezone: 'UTC', feature: `f${n}`, ref: 'trunk',
        profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], nextFireAt: DUE,
        createdById: ids.other, createdByType: 'USER', updatedById: ids.root, ...over,
      },
    });

  const reload = (id: string) => prisma.jobSchedule.findUniqueOrThrow({ where: { id } });

  /** The create body the routes accept; the repo is p1's. */
  const createBody = (feature: string, over: Record<string, unknown> = {}) => ({
    name: `nightly-${feature}`, repoId, feature, cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5, ...over,
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    ticker = app.get(ScheduleTicker);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // `other` owns the schedules the binding-only callers must not manage; `devBind`, `viewerBind` and
    // `adminBind` each hold one PROJECT-scope binding in p1 and no `ProjectMember` row.
    for (const who of ['other', 'devBind', 'viewerBind', 'adminBind', 'disabledOwner']) await createUser(who);

    const project = await asRoot('post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    repoId = (
      await prisma.fleetRepo.create({
        data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: ids.root },
      })
    ).id;

    await Promise.all([
      bind('devBind', 'developer'),
      bind('viewerBind', 'viewer'),
      bind('adminBind', 'project-admin'),
    ]);

    ids.agent = await createAgent('p1-schedule-agent');
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    // The tick tests need an empty fleet world: no other due schedule, no job in an active state and no
    // paused budget (which would skip the tick instead of dispatching). The rows a test creates are its own.
    await prisma.fleetJob.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — a viewer binding reads the schedules and may not create one
  // -------------------------------------------------------------------------

  it('AC-1: a user whose only source in p1 is a viewer binding is refused by the create with the permissions code', async () => {
    expect(await prisma.projectMember.count({ where: { userId: ids.viewerBind } })).toBe(0);

    expectPermissionsRefusal(await as('viewerBind', 'post', schedulesUrl(), createBody('viewer-create')));

    expect(await prisma.jobSchedule.count({ where: { projectId: p1Id } })).toBe(0);
  }, TIMEOUT);

  it('AC-2: that binding-only viewer lists the project schedules (200)', async () => {
    const existing = await scheduleRow();

    const res = await as('viewerBind', 'get', schedulesUrl()).expect(200);

    expect(data<ScheduleItem[]>(res).map((row) => row.id)).toEqual([existing.id]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 / AC-5 / AC-6 — create: the developer key, and the creator's type
  // -------------------------------------------------------------------------

  it('AC-3: a user whose only source in p1 is a developer binding creates a schedule (201)', async () => {
    await as('devBind', 'post', schedulesUrl(), createBody('dev-create')).expect(201);
  }, TIMEOUT);

  it('AC-4: that create stores the user as creator, typed USER', async () => {
    const res = await as('devBind', 'post', schedulesUrl(), createBody('dev-stored')).expect(201);
    const created = data<ScheduleItem>(res);

    expect(await reload(created.id)).toEqual(expect.objectContaining({ createdById: ids.devBind, createdByType: 'USER' }));
  }, TIMEOUT);

  it('AC-5: an agent rostered in p1 with AgentRoleEntry DEVELOPER creates a schedule (201)', async () => {
    await as('p1-schedule-agent', 'post', schedulesUrl(), createBody('agent-create')).expect(201);
  }, TIMEOUT);

  it('AC-6: that agent\'s create stores the agent as creator, typed AGENT', async () => {
    const res = await as('p1-schedule-agent', 'post', schedulesUrl(), createBody('agent-stored')).expect(201);
    const created = data<ScheduleItem>(res);

    expect(await reload(created.id)).toEqual(expect.objectContaining({ createdById: ids.agent, createdByType: 'AGENT' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 .. AC-12 — the `.own` keys keep owner-or-admin
  // -------------------------------------------------------------------------

  it('AC-7: the binding-only developer renames its own schedule (200)', async () => {
    const own = await scheduleRow({ createdById: ids.devBind, feature: 'own-rename' });

    const res = await as('devBind', 'patch', schedulesUrl(`/${own.id}`), { name: 'Renamed' }).expect(200);

    expect(data<ScheduleItem>(res).name).toBe('Renamed');
    expect((await reload(own.id)).name).toBe('Renamed');
  }, TIMEOUT);

  it('AC-8: the binding-only developer cannot patch another user\'s schedule, which is unchanged', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'foreign-patch' });

    expectPermissionsRefusal(await as('devBind', 'patch', schedulesUrl(`/${foreign.id}`), { name: 'Hijacked' }));

    expect(await reload(foreign.id)).toEqual(expect.objectContaining({ name: foreign.name, updatedById: ids.root }));
  }, TIMEOUT);

  it('AC-9: the binding-only developer cannot disable another user\'s schedule, which stays enabled', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'foreign-disable' });

    expectPermissionsRefusal(await as('devBind', 'post', schedulesUrl(`/${foreign.id}/disable`)));

    expect(await reload(foreign.id)).toEqual(expect.objectContaining({ enabled: true, disabledReason: null }));
  }, TIMEOUT);

  it('AC-10: the binding-only developer cannot delete another user\'s schedule, which survives', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'foreign-delete' });

    expectPermissionsRefusal(await as('devBind', 'delete', schedulesUrl(`/${foreign.id}`)));

    expect(await reload(foreign.id)).toEqual(expect.objectContaining({ id: foreign.id }));
  }, TIMEOUT);

  it('AC-11: a user whose only source in p1 is a project-admin binding patches another user\'s schedule (200)', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'admin-patch' });

    const res = await as('adminBind', 'patch', schedulesUrl(`/${foreign.id}`), { name: 'Renamed' }).expect(200);

    expect(data<ScheduleItem>(res).name).toBe('Renamed');
    expect((await reload(foreign.id)).name).toBe('Renamed');
  }, TIMEOUT);

  it('AC-12: that project-admin binding deletes another user\'s schedule (204)', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'admin-delete' });

    await as('adminBind', 'delete', schedulesUrl(`/${foreign.id}`)).expect(204);

    expect(await prisma.jobSchedule.findUnique({ where: { id: foreign.id } })).toBeNull();
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 .. AC-17, AC-25 — the fire rechecks the owner's own dispatch key
  // -------------------------------------------------------------------------

  it('AC-13: a due schedule owned by a developer-binding-only user fires one job', async () => {
    expect(await prisma.projectMember.count({ where: { userId: ids.devBind } })).toBe(0);
    const due = await scheduleRow({ createdById: ids.devBind, feature: 'us005-fires' });

    expect(await ticker.runOnce(NOW)).toEqual(expect.objectContaining({ dispatched: 1, disabled: 0 }));

    const jobs = await prisma.fleetJob.findMany({ where: { scheduleId: due.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ requestedById: ids.devBind, requestedByType: 'USER', state: 'QUEUED' }));
  }, TIMEOUT);

  it('AC-14 / AC-15: a due schedule owned by a viewer-binding-only user is disabled and creates no job', async () => {
    const due = await scheduleRow({ createdById: ids.viewerBind, feature: 'us005-viewer' });

    expect(await ticker.runOnce(NOW)).toEqual(expect.objectContaining({ dispatched: 0, disabled: 1 }));

    expect(await reload(due.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    expect(await prisma.fleetJob.count({ where: { scheduleId: due.id } })).toBe(0);
  }, TIMEOUT);

  it('AC-16: a due schedule owned by a rostered agent with AgentRoleEntry DEVELOPER fires as the agent', async () => {
    const due = await scheduleRow({ createdById: ids.agent, createdByType: 'AGENT', feature: 'us005-agent-fires' });

    expect(await ticker.runOnce(NOW)).toEqual(expect.objectContaining({ dispatched: 1, disabled: 0 }));

    const jobs = await prisma.fleetJob.findMany({ where: { scheduleId: due.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(expect.objectContaining({ requestedById: ids.agent, requestedByType: 'AGENT', state: 'QUEUED' }));
  }, TIMEOUT);

  it('AC-17: a due schedule owned by an agent that no longer exists is disabled with owner_lost_access', async () => {
    const due = await scheduleRow({ createdById: 'agent-that-is-gone', createdByType: 'AGENT', feature: 'us005-gone-agent' });

    expect(await ticker.runOnce(NOW)).toEqual(expect.objectContaining({ dispatched: 0, disabled: 1 }));

    expect(await reload(due.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
    expect(await prisma.fleetJob.count({ where: { scheduleId: due.id } })).toBe(0);
  }, TIMEOUT);

  it('AC-25: a due schedule whose USER owner is gone, or disabled, is disabled and dispatches nothing', async () => {
    const gone = await scheduleRow({ createdById: 'user-that-is-gone', feature: 'us005-gone-user' });
    await prisma.user.update({ where: { id: ids.disabledOwner }, data: { disabled: true } });
    const disabled = await scheduleRow({ createdById: ids.disabledOwner, feature: 'us005-disabled-user' });

    const result = await ticker.runOnce(NOW);

    expect(result).toEqual(expect.objectContaining({ dispatched: 0, disabled: 2 }));
    for (const schedule of [gone, disabled]) {
      expect(await reload(schedule.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'owner_lost_access' }));
      expect(await prisma.fleetJob.count({ where: { scheduleId: schedule.id } })).toBe(0);
    }
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-18 .. AC-20, AC-26 — enable rechecks the owner, and keeps owner-or-admin
  // -------------------------------------------------------------------------

  it('AC-18: a project-admin cannot enable a disabled schedule whose owner is only a viewer binding', async () => {
    const off = await scheduleRow({ createdById: ids.viewerBind, enabled: false, disabledReason: 'manual', feature: 'us005-enable-viewer' });

    const res = await as('adminBind', 'post', schedulesUrl(`/${off.id}/enable`)).expect(409);

    expect(res.body).toEqual(expect.objectContaining({ ret: 409, message: OWNER_NO_ACCESS }));
    expect(await reload(off.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual' }));
  }, TIMEOUT);

  it('AC-19 / AC-20: the binding-only developer owner enables its own disabled schedule, which is stored enabled', async () => {
    const off = await scheduleRow({ createdById: ids.devBind, enabled: false, disabledReason: 'manual', feature: 'us005-enable-own' });

    const res = await as('devBind', 'post', schedulesUrl(`/${off.id}/enable`)).expect(200);

    expect(data<ScheduleItem>(res).enabled).toBe(true);
    expect(await reload(off.id)).toEqual(expect.objectContaining({ enabled: true, disabledReason: null, noProgressTicks: 0 }));
  }, TIMEOUT);

  it('AC-26: a caller holding only the .own update key cannot enable another principal\'s schedule', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, enabled: false, disabledReason: 'manual', feature: 'us005-enable-foreign' });

    expectPermissionsRefusal(await as('devBind', 'post', schedulesUrl(`/${foreign.id}/enable`)));

    expect(await reload(foreign.id)).toEqual(expect.objectContaining({ enabled: false, disabledReason: 'manual' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // The 404s stay before the ownership check, and a non-holder never reaches one
  // -------------------------------------------------------------------------

  it('keeps the 404 for an unknown schedule ahead of ownership, for a key holder', async () => {
    await as('devBind', 'patch', schedulesUrl('/no-such-schedule'), { name: 'x' }).expect(404);
    await as('devBind', 'delete', schedulesUrl('/no-such-schedule')).expect(404);
    await as('devBind', 'post', schedulesUrl('/no-such-schedule/enable')).expect(404);
  }, TIMEOUT);

  it('answers the ownership refusal with the permissions code, not the membership one', async () => {
    const foreign = await scheduleRow({ createdById: ids.other, feature: 'us005-code' });

    const res = await as('devBind', 'patch', schedulesUrl(`/${foreign.id}`), { name: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ ret: 40003, message: PERMISSIONS_REFUSED }));
  }, TIMEOUT);
});
