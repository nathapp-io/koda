import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1d US-006 — the approval and budget routes decide with catalog keys (AC-1 .. AC-23, AC-26, AC-27).
 *
 * Permissions P3 7c US-008 re-pointed every case that read or decided through the fleet approval adapters
 * (`/api/projects/:slug/fleet/approvals`, `/api/fleet/approvals`) at the approval engine's routes, which US-010 keeps:
 * `GET /api/approvals?projectId=`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decisions` and
 * `GET /api/approvals/counts`. Two engine rules replace the adapters' key checks and the expectations below follow
 * them: visibility is the engine's (a caller reads its own requests and the ones it may decide, so a roster-only agent
 * that decides nothing lists none and an invisible request reads as 404), and a decision that is refused answers the
 * engine's `approvals.decideForbidden`/`approvals.notPending` rather than a fleet error.
 *
 * The budget routes (`/api/projects/:slug/fleet/budgets`, `/api/fleet/budgets`) are not approval routes and keep
 * their cases unchanged.
 *
 * Every caller below has exactly one kind of source in `p1`: one PROJECT-scope binding (users, no `ProjectMember` row
 * anywhere) or one `viewer` binding plus the role bindings the AC names (agents). No test asserts through a bypass: the
 * refusals are the routes' and the services' own.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const P2_SLUG = 'p2';
const P2_KEY = 'PTWO';
const DEL_SLUG = 'pdel';
const DEL_KEY = 'PDEL';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused route key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;

/** `approvals.decideForbidden.403`: the engine's refusal of a decision the caller may not make, with its reason. */
const DECIDE_FORBIDDEN = readI18n('approvals').decideForbidden as Record<string, string>;

interface ApprovalItem {
  id: string;
  permissionKey: string;
  projectId: string | null;
  status: string;
  details: { kind?: string; jobId?: string; resolvedBy: string | null } | null;
  decisions: Array<{ decision: string; deciderType: string; deciderId: string }>;
}
interface Counts {
  total: number;
  unscoped: number;
  projects: Array<{ projectId: string; slug: string; pending: number }>;
}

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
type AgentRole = 'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER';
const ROLE_KEY_FOR_AGENT_ROLE: Record<AgentRole, string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

describeIntegration('fleet approval and budget keys (US-006)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let p2Id = '';
  let delId = '';
  let repoId = '';
  let runnerId = '';
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
  /** The engine's routes (permissions P3 7c US-008), replacing the fleet approval adapters. */
  const projectApprovals = (projectId: string) => `/api/approvals?projectId=${projectId}`;
  const approvalUrl = (id: string) => `/api/approvals/${id}`;
  const decisionsUrl = (id: string) => `/api/approvals/${id}/decisions`;
  const countsUrl = '/api/approvals/counts';
  const budgetsUrl = (slug: string, suffix = '') => `/api/projects/${slug}/fleet/budgets${suffix}`;
  /** The fleet vocabulary on the engine route: `allow` / `allow_for_job` approve with a choice, `deny` rejects. */
  const allowBash = { decision: 'approve', params: { choice: 'allow' } };
  const rejectBash = { decision: 'reject' };

  /** The refusal contract of one refused route key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  /** The engine's refusal of a decision: 403 with its reason, never the retired fleet error codes. */
  const expectDecideRefusal = (res: request.Response, reason: string): void => {
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ ret: 403, message: (DECIDE_FORBIDDEN['403'] as string).replace('{reason}', reason) });
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

  /** The binding that is the caller's only source in the project. */
  const bind = (who: string, roleKey: string, projectId = p1Id): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'USER', id: ids[who] }, roleKey, projectId },
      { type: 'SYSTEM', id: 'test' },
    ));

  /**
   * A rostered agent: its only key source in `p1` is the `viewer` binding plus the role bindings
   * `roles` names (none when it is empty).
   */
  const createAgent = async (slug: string, roles: AgentRole[] = []): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(prisma, agent);
    await grantRole(prisma, agent, 'viewer', p1Id);
    for (const role of roles) await grantRole(prisma, agent, ROLE_KEY_FOR_AGENT_ROLE[role], p1Id);
    tokens[slug] = body.apiKey;
    // The bindings are written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** A job of `p1`; the default requester is `other`, a user. */
  const jobRow = (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}): Promise<{ id: string; leaseEpoch: number }> =>
    prisma.fleetJob.create({
      data: {
        projectId: p1Id, repoId, ref: 'trunk', command: 'RUN', feature: `f${(n += 1)}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: ids.other, requestedByType: 'USER',
        state: 'RUNNING', runnerId, leaseEpoch: 1, bashMode: 'escalate', firstStartedAt: new Date(), ...over,
      },
      select: { id: true, leaseEpoch: true },
    });

  /**
   * A pending bash ask of a RUNNING job `over` describes, on the approval engine: the ask is on behalf of the job's
   * requester, which is what the self-decide rule reads.
   */
  const bashAsk = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => {
    const job = await jobRow(over);
    const naxAskId = `ask-${(n += 1)}`;
    const payload = { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] };
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: p1Id,
      onBehalfOf: { type: over.requestedByType === 'AGENT' ? 'AGENT' : 'USER', id: over.requestedById ?? ids.other },
      expiresAt: new Date(Date.now() + 300_000),
      input: { jobId: job.id, leaseEpoch: job.leaseEpoch, naxAskId, payload },
      link: { jobId: job.id, leaseEpoch: job.leaseEpoch, naxAskId },
    });
    return { job, approval: { id: requestId, naxAskId } };
  };

  /** A pending bash ask of a project with no job row: the counts and the list read the request and its project only. */
  const bashAskIn = (projectId: string) =>
    seedFleetAsk(prisma, {
      kind: 'bash', projectId, expiresAt: new Date(Date.now() + 300_000),
      input: { jobId: `count-${(n += 1)}`, leaseEpoch: 0, naxAskId: `count-ask-${n}`, payload: {} },
      link: { jobId: `count-${n}`, leaseEpoch: 0, naxAskId: `count-ask-${n}` },
    });

  /**
   * A pending budget ask of a fresh policy. `projectId` null makes it a global-policy ask, which is counted as
   * unscoped.
   */
  const budgetAsk = async (projectId: string | null) => {
    const policy = await prisma.budgetPolicy.create({
      data: projectId === null
        ? {
          scopeType: 'global', scopeKey: 'global', windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(10),
          warnPercent: null, createdById: ids.root, updatedById: ids.root,
        }
        : {
          scopeType: 'project', scopeId: projectId, scopeKey: `project:${projectId}`, projectId, windowKind: 'calendar_month_utc',
          amountUsd: new Prisma.Decimal(10), warnPercent: null, createdById: ids.root, updatedById: ids.root,
        },
    });
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'budget', projectId,
      input: {
        policyId: policy.id, scopeType: policy.scopeType, scopeId: policy.scopeId, windowKind: policy.windowKind,
        windowStart: new Date(0).toISOString(), spentUsd: '10', amountUsd: '10', requestedAt: new Date().toISOString(),
      },
      link: { budgetPolicyId: policy.id },
    });
    return { policy, approval: { id: requestId } };
  };

  /** The engine request and its last decision: what the assertions below are built from. */
  const reloadApproval = (id: string) => prisma.approvalRequest.findUniqueOrThrow({
    where: { id }, include: { decisions: { orderBy: { decidedAt: 'desc' }, take: 1 } },
  });
  const commandsFor = (jobId: string) => prisma.fleetCommand.findMany({ where: { jobId, type: 'APPROVAL_ANSWER' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    membership = app.get(MembershipService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // `other` requests the jobs and is nobody's member; `devBind`, `viewerBind` and `adminBind` each hold
    // one PROJECT-scope binding in `p1` and no `ProjectMember` row.
    for (const who of ['other', 'devBind', 'viewerBind', 'adminBind']) await createUser(who);

    for (const [slug, key] of [[P1_SLUG, P1_KEY], [P2_SLUG, P2_KEY], [DEL_SLUG, DEL_KEY]] as const) {
      const project = await asRoot('post', '/api/projects', { name: slug, slug, key }).expect(201);
      const id = data<{ id: string }>(project).id;
      if (slug === P1_SLUG) p1Id = id;
      else if (slug === P2_SLUG) p2Id = id;
      else delId = id;
    }
    // A soft-deleted project is not listed by the counts even when an approval of it is pending.
    await prisma.project.update({ where: { id: delId }, data: { deletedAt: new Date() } });

    repoId = (await prisma.fleetRepo.create({
      data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: ids.root },
    })).id;
    runnerId = (await prisma.runner.create({
      data: {
        name: 'us006-runner', apiKeyHash: 'hash-us006', os: 'linux', arch: 'x64', labels: ['linux'], capacity: 1,
        capabilities: {} as Prisma.InputJsonValue, daemonVersion: '0.1.0', protocolVersion: 1, bootId: 'boot-1',
        enabled: false, lastSeenAt: new Date(), createdById: ids.root,
      },
      select: { id: true },
    })).id;

    await Promise.all([
      bind('devBind', 'developer'),
      bind('viewerBind', 'viewer'),
      bind('adminBind', 'project-admin'),
    ]);

    ids.rosterAgent = await createAgent('p1-approval-roster-agent');
    ids.devAgent = await createAgent('p1-approval-dev-agent', ['DEVELOPER']);
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.chatThread.deleteMany();
    await prisma.budgetIncident.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: ids.root },
      { type: 'USER', id: ids.other },
      { type: 'USER', id: ids.devBind },
      { type: 'USER', id: ids.viewerBind },
      { type: 'USER', id: ids.adminBind },
      { type: 'AGENT', id: ids.rosterAgent },
      { type: 'AGENT', id: ids.devAgent },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — the engine's visibility, not the roster's
  // -------------------------------------------------------------------------

  it('AC-1: a roster-only agent lists no rows; the same ask is listed for a binding that may decide it', async () => {
    const { approval } = await bashAsk();

    // US-008: the page holds the caller's own requests and the ones it may decide. A roster-only agent (a viewer
    // binding, which holds no `approval.decide`) decides nothing here, so its page is empty — 200, never a 403.
    const mine = await as('p1-approval-roster-agent', 'get', projectApprovals(p1Id)).expect(200);
    expect(data<{ records: ApprovalItem[] }>(mine).records).toEqual([]);

    // The same ask is one row for the developer binding, which holds the narrowed
    // `approval.decide@fleet.job.shell.escalate`, so the empty page above is about visibility, not a missing row.
    const decider = await as('devBind', 'get', projectApprovals(p1Id)).expect(200);
    expect(data<{ records: ApprovalItem[] }>(decider).records.map((a) => a.id)).toEqual([approval.id]);
  }, TIMEOUT);

  it('AC-2: the roster-only agent reads the ask as 404; a decider reads it with its job in details', async () => {
    const { approval, job } = await bashAsk();

    await as('p1-approval-roster-agent', 'get', approvalUrl(approval.id)).expect(404);

    const res = await as('devBind', 'get', approvalUrl(approval.id)).expect(200);
    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({
      id: approval.id, permissionKey: 'fleet.job.shell.escalate', projectId: p1Id, status: 'pending',
    }));
    expect(data<ApprovalItem>(res).details).toEqual(expect.objectContaining({ kind: 'bash', jobId: job.id }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 / AC-5 — a DEVELOPER agent decides a bash ask of a user's job
  // -------------------------------------------------------------------------

  it('AC-3: a DEVELOPER agent allows a pending bash ask of a RUNNING job requested by a user (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('p1-approval-dev-agent', 'post', decisionsUrl(approval.id), allowBash).expect(200);

    // The engine runs the bash command in the deciding call, so the request it answers is `executed`.
    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({ status: 'executed' }));
  }, TIMEOUT);

  it('AC-4: that allow creates an APPROVAL_ANSWER command for the job', async () => {
    const { job, approval } = await bashAsk();

    await as('p1-approval-dev-agent', 'post', decisionsUrl(approval.id), allowBash).expect(200);

    const commands = await commandsFor(job.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({ runnerId, leaseEpoch: 1, type: 'APPROVAL_ANSWER' }));
    expect(commands[0]?.payload).toEqual(expect.objectContaining({ approvalId: approval.id, naxAskId: approval.naxAskId, choice: 'allow' }));
  }, TIMEOUT);

  it('AC-5: that allow stores the agent as the decider', async () => {
    const { approval } = await bashAsk();

    await as('p1-approval-dev-agent', 'post', decisionsUrl(approval.id), allowBash).expect(200);

    const decided = await reloadApproval(approval.id);
    expect(decided.status).toBe('executed');
    expect(decided.decisions[0]).toMatchObject({ decision: 'approve', deciderId: ids.devAgent, deciderType: 'AGENT' });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 / AC-8 / AC-9 — the key each ask type needs
  // -------------------------------------------------------------------------

  it('AC-6: a viewer binding cannot reach the bash ask at all, and it stays pending with no command', async () => {
    const { job, approval } = await bashAsk();

    // A viewer holds neither `approval.decide` nor the ask's action key, so the engine hides the request: 404.
    await as('viewerBind', 'post', decisionsUrl(approval.id), allowBash).expect(404);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decisions: [] }));
    expect(await commandsFor(job.id)).toHaveLength(0);
  }, TIMEOUT);

  it('AC-7: a developer binding is refused by the budget decide and the ask stays pending', async () => {
    const { approval } = await budgetAsk(p1Id);

    // A developer decides only `fleet.job.shell.escalate`, so a budget ask is outside its decide scope: 404.
    await as('devBind', 'post', decisionsUrl(approval.id), rejectBash).expect(404);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decisions: [] }));
  }, TIMEOUT);

  it('AC-8: a project-admin binding decides the same budget ask (200)', async () => {
    const { approval } = await budgetAsk(p1Id);

    await as('adminBind', 'post', decisionsUrl(approval.id), rejectBash).expect(200);
  }, TIMEOUT);

  it('AC-9: that keep_paused leaves the approval rejected', async () => {
    const { approval } = await budgetAsk(p1Id);

    await as('adminBind', 'post', decisionsUrl(approval.id), rejectBash).expect(200);

    const decided = await reloadApproval(approval.id);
    expect(decided.status).toBe('rejected');
    expect(decided.decisions[0]).toMatchObject({ decision: 'reject', deciderId: ids.adminBind });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 — a global admin decides a project's bash ask on the same route
  // -------------------------------------------------------------------------

  it('AC-10: a global admin allows a pending bash ask (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('root', 'post', decisionsUrl(approval.id), allowBash).expect(200);

    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({ status: 'executed' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 / AC-12 — one engine route, so scope is the ask's project, not a route prefix
  // -------------------------------------------------------------------------

  it('AC-11: a non-admin user\'s page holds its own ask and none of another principal\'s', async () => {
    const mine = await bashAsk();
    const theirs = await bashAsk({ requestedById: ids.adminBind });

    // `other` holds no decide key, so the engine shows it its own requests: the ask it requested, never another's.
    const res = await as('other', 'get', projectApprovals(p1Id)).expect(200);

    expect(data<{ records: ApprovalItem[] }>(res).records.map((row) => row.id)).toEqual([mine.approval.id]);
    expect(data<{ records: ApprovalItem[] }>(res).records.map((row) => row.id)).not.toContain(theirs.approval.id);
  }, TIMEOUT);

  it('AC-12: the project-admin decide the admin prefix refused is accepted on the engine route', async () => {
    const { approval } = await budgetAsk(p1Id);

    // There is no admin prefix on the engine: the caller's keys in the ask's own project are the authority.
    await as('adminBind', 'post', decisionsUrl(approval.id), rejectBash).expect(200);

    const decided = await reloadApproval(approval.id);
    expect(decided.status).toBe('rejected');
    expect(decided.decisions).toHaveLength(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 .. AC-18 — the counts follow the caller's decide scope
  // -------------------------------------------------------------------------

  it('AC-14: a developer binding counts only its own project\'s pending bash ask', async () => {
    await bashAsk();
    await bashAskIn(p2Id);

    const res = await as('devBind', 'get', countsUrl).expect(200);

    expect(data<Counts>(res)).toEqual({ projects: [{ projectId: p1Id, slug: P1_SLUG, pending: 1 }], unscoped: 0, total: 1 });
  }, TIMEOUT);

  it('AC-15: a rostered agent reads the counts (200)', async () => {
    await bashAsk();

    await as('p1-approval-roster-agent', 'get', countsUrl).expect(200);
  }, TIMEOUT);

  it('AC-16: a roster-only agent\'s counts list nothing, while the binding that may decide counts p1', async () => {
    await bashAsk();

    // US-008: a roster-only agent may decide nothing, so it counts nothing — no project row at all.
    expect(data<Counts>(await as('p1-approval-roster-agent', 'get', countsUrl).expect(200)))
      .toEqual({ projects: [], unscoped: 0, total: 0 });
    expect(data<Counts>(await as('devBind', 'get', countsUrl).expect(200)))
      .toEqual({ projects: [{ projectId: p1Id, slug: P1_SLUG, pending: 1 }], unscoped: 0, total: 1 });
  }, TIMEOUT);

  it('AC-17: a global admin counts every live project and the soft-deleted one (7a)', async () => {
    await budgetAsk(p1Id);
    await budgetAsk(p2Id);
    await budgetAsk(delId);

    const res = await as('root', 'get', countsUrl).expect(200);

    // Permissions P3 7a: a soft-deleted project's pending request is still counted; only the slug follows the row.
    expect(data<Counts>(res)).toEqual({
      projects: [
        expect.objectContaining({ projectId: p1Id, slug: P1_SLUG, pending: 1 }),
        expect.objectContaining({ projectId: p2Id, slug: P2_SLUG, pending: 1 }),
        expect.objectContaining({ projectId: delId, slug: DEL_SLUG, pending: 1 }),
      ],
      unscoped: 0,
      total: 3,
    });
  }, TIMEOUT);

  it('AC-18: a global admin\'s counts include a global policy\'s pending approval in unscoped', async () => {
    await budgetAsk(null);

    const res = await as('root', 'get', countsUrl).expect(200);

    expect(data<Counts>(res)).toEqual({ projects: [], unscoped: 1, total: 1 });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-19 .. AC-23 — the budget routes check their own keys
  // -------------------------------------------------------------------------

  it('AC-19: a developer binding is refused by the project budget create and no policy is stored', async () => {
    expectPermissionsRefusal(await as('devBind', 'post', budgetsUrl(P1_SLUG), projectBudget()));

    expect(await prisma.budgetPolicy.count({ where: { projectId: p1Id } })).toBe(0);
  }, TIMEOUT);

  it('AC-20: a project-admin binding creates the same project budget (201)', async () => {
    await as('adminBind', 'post', budgetsUrl(P1_SLUG), projectBudget()).expect(201);

    expect(await prisma.budgetPolicy.count({ where: { projectId: p1Id } })).toBe(1);
  }, TIMEOUT);

  it('AC-21: a viewer binding reads the project budgets (200)', async () => {
    await as('viewerBind', 'get', budgetsUrl(P1_SLUG)).expect(200);
  }, TIMEOUT);

  it('AC-22: a non-admin user is refused by the global budget create and no policy is stored', async () => {
    expectPermissionsRefusal(await as('other', 'post', '/api/fleet/budgets', globalBudget()));

    expect(await prisma.budgetPolicy.count({ where: { scopeType: 'global' } })).toBe(0);
  }, TIMEOUT);

  it('AC-23: a global admin creates the same global budget (201)', async () => {
    await as('root', 'post', '/api/fleet/budgets', globalBudget()).expect(201);

    expect(await prisma.budgetPolicy.count({ where: { scopeType: 'global' } })).toBe(1);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-26 / AC-27 — an agent cannot decide an ask of a job it requested
  // -------------------------------------------------------------------------

  it('AC-26: a DEVELOPER agent is refused its own job\'s bash ask with the engine\'s tier refusal', async () => {
    const { approval } = await bashAsk({ requestedById: ids.devAgent, requestedByType: 'AGENT' });

    const res = await as('p1-approval-dev-agent', 'post', decisionsUrl(approval.id), allowBash);

    // The ask is on behalf of the agent, and an agent contributes only `self` to an `agent`-mode ask.
    expectDecideRefusal(res, 'tier-too-low');
  }, TIMEOUT);

  it('AC-27: after that refusal the ask is still pending and no command exists', async () => {
    const { job, approval } = await bashAsk({ requestedById: ids.devAgent, requestedByType: 'AGENT' });

    await as('p1-approval-dev-agent', 'post', decisionsUrl(approval.id), allowBash).expect(403);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decisions: [] }));
    expect(await commandsFor(job.id)).toHaveLength(0);
  }, TIMEOUT);
});

function projectBudget(): Record<string, unknown> {
  return { scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd: 25 };
}

function globalBudget(): Record<string, unknown> {
  return { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 25 };
}
