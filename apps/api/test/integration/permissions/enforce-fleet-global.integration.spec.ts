/**
 * Permissions P1d US-008 — the global fleet admin routes decide with catalog keys, and
 * `GET /fleet/activity` is filtered by `fleet.activity.read` over real HTTP + Postgres
 * (AC-1 .. AC-20).
 *
 * Every caller below has exactly one kind of source: one GLOBAL-scope binding (the agent that reads
 * the runner list as a global admin), one PROJECT-scope binding (the users and the agent's roles), or
 * one `viewer` binding (the agent that only reads p1). `plain` has no source at all.
 * No test asserts through a bypass: the refusals are the routes' and the filter is the controller's.
 *
 * The application boots with `FLEET_TEST_HOOKS=true`, because AC-13 fires a schedule through the
 * test-only hook; the hook's own 404 when it is off is covered by `fleet-test-hooks.integration.spec.ts`.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/enforce-fleet-global.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const P2_SLUG = 'p2';
const P2_KEY = 'PTWO';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;

interface ActivityItem { id: string; action: string; actorType: string; actorId: string; projectId: string | null }
interface RunnerItem { id: string; enabled: boolean }

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
const ROLE_KEY_FOR_AGENT_ROLE: Record<'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER', string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

describeIntegration('global fleet route keys and the key-filtered activity feed (US-008)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let p2Id = '';
  let repoId = '';
  let runnerId = '';
  let n = 0;

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth(who));
    return body === undefined ? req : req.send(body);
  };
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };

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

  /** The binding that is the caller's only source. */
  const bind = (
    principal: { type: 'USER' | 'AGENT'; id: string },
    roleKey: string,
    projectId: string | null,
  ): Promise<unknown> => membership.createBinding({ principal, roleKey, projectId }, { type: 'SYSTEM', id: 'test' });

  /** A rostered agent: its only key source in p1 is the `viewer` binding plus the role binding given. */
  const createAgent = async (slug: string, agentRole?: 'DEVELOPER'): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(prisma, agent);
    await grantRole(prisma, agent, 'viewer', p1Id);
    if (agentRole) await grantRole(prisma, agent, ROLE_KEY_FOR_AGENT_ROLE[agentRole], p1Id);
    tokens[slug] = body.apiKey;
    // The bindings are written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** One activity row in `projectId` (`null` = the project-less row the global view alone lists). */
  const activityRow = (projectId: string | null, action: string): Promise<{ id: string }> =>
    prisma.fleetActivity.create({
      data: {
        actorType: 'SYSTEM', actorId: 'system', action, entityType: 'job', entityId: `${action}-${(n += 1)}`,
        projectId, payload: {},
      },
      select: { id: true },
    });

  /** The ids the caller's activity listing carries, read from the page the feed answers. */
  const activityIds = async (who: string): Promise<string[]> => {
    const res = await as(who, 'get', '/api/fleet/activity?size=100').expect(200);
    return data<{ records: ActivityItem[] }>(res).records.map((row) => row.id);
  };

  const jobCount = () => prisma.fleetJob.count();

  /** A due schedule of p1 owned by the global admin, for the test-hook cases. */
  const hookSchedule = () =>
    prisma.jobSchedule.create({
      data: {
        projectId: p1Id, repoId, name: `us008-hook-${(n += 1)}`, cron: '0 3 1 1 *', timezone: 'UTC', feature: `us008-hook-${n}`,
        ref: 'trunk', profiles: [], maxCostUsd: new Prisma.Decimal(5), selectorLabels: [],
        nextFireAt: new Date('2026-10-01T03:00:00.000Z'), createdById: ids.root, createdByType: 'USER', updatedById: ids.root,
      },
    });

  beforeAll(async () => {
    await resetDb();
    // Config factories read process.env during AppFactory.create (AC-13 fires through the test hook).
    const previousHooks = process.env.FLEET_TEST_HOOKS;
    process.env.FLEET_TEST_HOOKS = 'true';
    try {
      app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    } finally {
      if (previousHooks === undefined) delete process.env.FLEET_TEST_HOOKS;
      else process.env.FLEET_TEST_HOOKS = previousHooks;
    }
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // `plain` holds no key at all; `projectAdmin` and `devBind` hold one PROJECT-scope binding in p1.
    for (const who of ['plain', 'projectAdmin', 'devBind']) await createUser(who);

    for (const [slug, key, idKey] of [[P1_SLUG, P1_KEY, 'p1'], [P2_SLUG, P2_KEY, 'p2']] as const) {
      const project = await asRoot('post', '/api/projects', { name: slug, slug, key }).expect(201);
      const id = data<{ id: string }>(project).id;
      if (idKey === 'p1') p1Id = id;
      else p2Id = id;
    }
    repoId = (await prisma.fleetRepo.create({
      data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: ids.root },
    })).id;
    runnerId = (await prisma.runner.create({
      data: {
        name: 'us008-runner', apiKeyHash: 'hash-us008', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1,
        capabilities: {} as Prisma.InputJsonValue, daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1',
        enabled: true, lastSeenAt: new Date(), createdById: ids.root,
      },
      select: { id: true },
    })).id;

    await Promise.all([
      bind({ type: 'USER', id: ids.projectAdmin }, 'project-admin', p1Id),
      bind({ type: 'USER', id: ids.devBind }, 'developer', p1Id),
    ]);

    ids.rosterAgent = await createAgent('p1-activity-roster-agent');
    ids.devAgent = await createAgent('p1-activity-dev-agent', 'DEVELOPER');
    // The agent that reads the runner admin list only through a GLOBAL admin binding.
    ids.globalAdminAgent = await createAgent('global-admin-agent');
    await bind({ type: 'AGENT', id: ids.globalAdminAgent }, 'admin', null);
    await membership.invalidatePermissions();
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.fleetJob.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: ids.root },
      { type: 'USER', id: ids.plain },
      { type: 'USER', id: ids.projectAdmin },
      { type: 'USER', id: ids.devBind },
      { type: 'AGENT', id: ids.rosterAgent },
      { type: 'AGENT', id: ids.devAgent },
      { type: 'AGENT', id: ids.globalAdminAgent },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — the dashboard and the credential board
  // -------------------------------------------------------------------------

  it('AC-1: a non-admin user is refused by GET /fleet/dashboard with the permissions code', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/dashboard'));
  }, TIMEOUT);

  it('AC-2: a non-admin user is refused by GET /fleet/credential-board with the permissions code', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/credential-board'));
  }, TIMEOUT);

  it('AC-3: a global admin gets 200 from GET /fleet/dashboard', async () => {
    await asRoot('get', '/api/fleet/dashboard').expect(200);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 / AC-5 — ingest health and the backfill
  // -------------------------------------------------------------------------

  it('AC-4: a non-admin user is refused by GET /fleet/ingest with the permissions code', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/ingest'));
  }, TIMEOUT);

  it('AC-5: a non-admin user is refused by POST /fleet/ingest/backfill and nothing is queued', async () => {
    expectPermissionsRefusal(await as('plain', 'post', '/api/fleet/ingest/backfill'));

    expect(await prisma.fleetBundleIngest.count()).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 — the repo admin routes
  // -------------------------------------------------------------------------

  it('AC-6: a non-admin user is refused by GET /fleet/repos with the permissions code', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/repos'));
  }, TIMEOUT);

  it('AC-7: a non-admin user is refused by POST /fleet/repos with a valid body and no repo is stored', async () => {
    const before = await prisma.fleetRepo.count();

    expectPermissionsRefusal(await as('plain', 'post', '/api/fleet/repos', {
      projectSlug: P1_SLUG, provider: 'github', owner: 'acme', name: 'never-registered',
    }));

    expect(await prisma.fleetRepo.count()).toBe(before);
    expect(await prisma.fleetRepo.count({ where: { name: 'never-registered' } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-8 / AC-9 / AC-10 / AC-15 — the runner admin routes and enrollments
  // -------------------------------------------------------------------------

  it('AC-8: a non-admin user is refused by GET /fleet/runners with the permissions code', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/runners'));
  }, TIMEOUT);

  it('AC-9: a non-admin user is refused by POST /fleet/enrollments and no token is issued', async () => {
    expectPermissionsRefusal(await as('plain', 'post', '/api/fleet/enrollments', { labels: ['linux'] }));

    expect(await prisma.runnerEnrollment.count()).toBe(0);
  }, TIMEOUT);

  it('AC-10: a global admin gets 200 from GET /fleet/runners', async () => {
    const res = await asRoot('get', '/api/fleet/runners').expect(200);

    expect(data<{ records: RunnerItem[] }>(res).records.map((row) => row.id)).toContain(runnerId);
  }, TIMEOUT);

  it('AC-15: a user whose only source in p1 is a project-admin binding is refused by PATCH /fleet/runners/<id>', async () => {
    expectPermissionsRefusal(await as('projectAdmin', 'patch', `/api/fleet/runners/${runnerId}`, { enabled: false }));

    expect(await prisma.runner.findUniqueOrThrow({ where: { id: runnerId } })).toEqual(expect.objectContaining({ enabled: true }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 / AC-12 — the global analytics routes
  // -------------------------------------------------------------------------

  it('AC-11: a non-admin user is refused by GET /fleet/analytics/spend with a valid window', async () => {
    expectPermissionsRefusal(await as('plain', 'get', '/api/fleet/analytics/spend?from=2026-09-28T00:00:00Z&to=2026-10-12T00:00:00Z&groupBy=project'));
  }, TIMEOUT);

  it('AC-12: a non-admin user is refused by DELETE /fleet/analytics with valid before and confirm', async () => {
    expectPermissionsRefusal(await as('plain', 'delete', '/api/fleet/analytics?before=2026-10-01T00:00:00Z', { confirm: 'ALL' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 — the schedule test hook keeps its key, and the hook stays on
  // -------------------------------------------------------------------------

  it('AC-13: with test hooks enabled a non-admin user is refused by the schedule fire and no job is created', async () => {
    const schedule = await hookSchedule();

    expectPermissionsRefusal(await as('plain', 'post', `/api/fleet/test-hooks/schedules/${schedule.id}/fire`));

    expect(await jobCount()).toBe(0);
  }, TIMEOUT);

  it('keeps the test hook itself on, so the refusal above is the key and not the hook being off', async () => {
    const schedule = await hookSchedule();

    await asRoot('post', `/api/fleet/test-hooks/schedules/${schedule.id}/fire`).expect(200);

    expect(await prisma.fleetJob.count({ where: { scheduleId: schedule.id } })).toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 — an agent with a global admin binding reads the runner list
  // -------------------------------------------------------------------------

  it('AC-14: an agent with a global admin binding gets 200 from GET /fleet/runners', async () => {
    const res = await as('global-admin-agent', 'get', '/api/fleet/runners').expect(200);

    expect(data<{ records: RunnerItem[] }>(res).records.map((row) => row.id)).toContain(runnerId);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 / AC-17 — the feed is filtered by the read key
  // -------------------------------------------------------------------------

  it('AC-16: a developer-binding-only user in p1 sees p1\'s rows and neither p2\'s nor the project-less rows', async () => {
    expect(await prisma.roleBinding.count({ where: { principalId: ids.devBind, projectId: p2Id } })).toBe(0);
    const inP1 = await activityRow(p1Id, 'job.dispatched');
    const inP2 = await activityRow(p2Id, 'job.dispatched');
    const projectLess = await activityRow(null, 'repo.checked');

    const mine = await activityIds('devBind');

    expect(mine).toContain(inP1.id);
    expect(mine).not.toContain(inP2.id);
    expect(mine).not.toContain(projectLess.id);
    // The rows are not invisible to everyone: the global admin's view carries all three, so the
    // assertions above are about the caller's scope, not about rows that were never written.
    const all = await activityIds('root');
    expect(all).toEqual(expect.arrayContaining([inP1.id, inP2.id, projectLess.id]));
  }, TIMEOUT);

  it('AC-17: a global admin\'s feed lists the p1 rows, the p2 rows and the project-less rows', async () => {
    const inP1 = await activityRow(p1Id, 'job.dispatched');
    const inP2 = await activityRow(p2Id, 'job.dispatched');
    const projectLess = await activityRow(null, 'repo.checked');

    const res = await asRoot('get', '/api/fleet/activity?size=100').expect(200);
    const rows = data<{ records: ActivityItem[] }>(res).records;

    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([inP1.id, inP2.id, projectLess.id]));
    expect(rows.find((row) => row.id === projectLess.id)?.projectId).toBeNull();
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-18 / AC-19 — a roster-only agent reads its own project's feed
  // -------------------------------------------------------------------------

  it('AC-18: an agent rostered in p1 with no AgentRoleEntry gets 200 from GET /fleet/activity', async () => {
    await as('p1-activity-roster-agent', 'get', '/api/fleet/activity').expect(200);
  }, TIMEOUT);

  it('AC-19: that roster-only agent\'s feed lists only p1\'s rows', async () => {
    const inP1 = await activityRow(p1Id, 'job.dispatched');
    const inP2 = await activityRow(p2Id, 'job.dispatched');
    const projectLess = await activityRow(null, 'repo.checked');

    const mine = await activityIds('p1-activity-roster-agent');

    expect(mine).toContain(inP1.id);
    expect(mine).not.toContain(inP2.id);
    expect(mine).not.toContain(projectLess.id);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-20 — an agent's dispatch reaches the global feed, labelled AGENT
  // -------------------------------------------------------------------------

  it('AC-20: a global admin\'s feed lists the AGENT dispatch row of a job an agent requested', async () => {
    const created = await as('p1-activity-dev-agent', 'post', `/api/projects/${P1_SLUG}/fleet/jobs`, {
      repoId, command: 'RUN', maxCostUsd: 5, feature: 'us008-agent-dispatch',
    }).expect(201);
    const jobId = data<{ job: { id: string } }>(created).job.id;

    const res = await asRoot('get', `/api/fleet/activity?jobId=${jobId}`).expect(200);
    const rows = data<{ records: ActivityItem[] }>(res).records;
    const dispatched = rows.filter((row) => row.action === 'job.dispatched');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual(expect.objectContaining({ actorType: 'AGENT', actorId: ids.devAgent }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // The key holders keep the routes' own 404s: the guard refuses first, not instead
  // -------------------------------------------------------------------------

  it('keeps the non-permission errors of a key holder unchanged', async () => {
    await asRoot('get', '/api/fleet/runners/no-such-runner').expect(404);
    await asRoot('post', '/api/fleet/repos/no-such-repo/check').expect(404);
    await asRoot('post', '/api/fleet/ingest/jobs/no-such-job/rerun').expect(404);
  }, TIMEOUT);
});
