import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1d US-006 — the fleet approval and budget routes decide with catalog keys, the decide
 * key is chosen per approval type in `ApprovalsService.decide`, `GET /fleet/approval-counts` is
 * filtered with `projectIdsWithKey`, and an agent can never decide an ask of a job it requested
 * (AC-1 .. AC-23, AC-26, AC-27).
 *
 * Every caller below has exactly one kind of source in `p1`: one PROJECT-scope binding (users, no
 * `ProjectMember` row anywhere) or one `viewer` binding plus the role bindings the AC names (agents).
 * No test asserts through a bypass: the refusals are the routes' and the service's own.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/permissions/enforce-fleet-approvals-budgets.integration.spec.ts
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

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;

/**
 * The `403` sentence of a nested i18n key, or `''` when the key is missing. The two callers below
 * assert the sentence is non-empty, so a missing translation fails the case that reads it instead of
 * crashing this module — and an untranslated code comes back as the raw key, never as `''`.
 */
const refusalSentence = (file: string, key: string): string =>
  (readI18n(file)[key] as Record<string, string> | undefined)?.['403'] ?? '';

/** `fleet.approvalSelfDecide`, the refusal an agent gets for its own job's ask. */
const SELF_DECIDE = refusalSentence('fleet', 'approvalSelfDecide');
/** `threads.notCreator`, the unchanged refusal of an `assistant_action` ask. */
const NOT_CREATOR = refusalSentence('threads', 'notCreator');

interface ApprovalItem { id: string; type: string; status: string; decision: string | null; decidedById: string | null }
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
  const approvalsUrl = (slug: string, suffix = '') => `/api/projects/${slug}/fleet/approvals${suffix}`;
  const budgetsUrl = (slug: string, suffix = '') => `/api/projects/${slug}/fleet/budgets${suffix}`;

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

  /** The binding that is the caller's only source in the project. */
  const bind = (who: string, roleKey: string, projectId = p1Id): Promise<unknown> =>
    membership.createBinding(
      { principal: { type: 'USER', id: ids[who] }, roleKey, projectId },
      { type: 'SYSTEM', id: 'test' },
    );

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

  /** A pending bash ask of a RUNNING job `over` describes. */
  const bashAsk = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => {
    const job = await jobRow(over);
    const approval = await prisma.fleetApproval.create({
      data: {
        type: 'nax_bash_escalate', projectId: p1Id, jobId: job.id, leaseEpoch: job.leaseEpoch, naxAskId: `ask-${(n += 1)}`,
        payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] },
        requestedAt: new Date(), expiresAt: new Date(Date.now() + 300_000),
      },
    });
    return { job, approval };
  };

  /**
   * A pending budget ask of a fresh policy. `projectId` null makes it a global-policy ask, which only
   * the admin routes list and count.
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
    const approval = await prisma.fleetApproval.create({
      data: {
        type: 'budget_override_required', projectId, policyId: policy.id, requestedAt: new Date(),
        payload: { scopeType: policy.scopeType, windowKind: policy.windowKind, spentUsd: '10', amountUsd: '10' },
      },
    });
    return { policy, approval };
  };

  /** A pending `assistant_action` ask whose requesting user is `requesterId`. */
  const assistantAsk = async (requesterId: string) => {
    // The handler reads the action back through the thread repository, which rejects a row without its
    // thread fields, so the ask is anchored on a real thread and job like the assistant's own writes are.
    const thread = await prisma.chatThread.create({
      data: {
        projectId: p1Id, kind: 'REPO', repoId, title: `us006-thread-${(n += 1)}`, createdById: requesterId,
        backend: { kind: 'native' } as Prisma.InputJsonValue, skills: [] as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    const job = await jobRow({ threadId: thread.id });
    const action = await prisma.pendingAction.create({
      data: {
        projectId: p1Id, threadId: thread.id, jobId: job.id, toolCallId: `tc-${(n += 1)}`,
        tool: 'koda_add_comment', input: { ref: 'X-1', body: 'hi' } as Prisma.InputJsonValue,
        preview: 'Add a comment', status: 'PENDING', expiresAt: new Date(Date.now() + 3_600_000), actorType: 'user', actorId: requesterId,
      },
    });
    return prisma.fleetApproval.create({
      data: {
        type: 'assistant_action', projectId: p1Id, jobId: job.id, requestedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
        payload: { actionId: action.id, tool: 'koda_add_comment', threadId: thread.id, threadPath: `/threads/${thread.id}`, requestedById: requesterId },
      },
    });
  };

  const reloadApproval = (id: string) => prisma.fleetApproval.findUniqueOrThrow({ where: { id } });
  const commandsFor = (jobId: string) => prisma.fleetCommand.findMany({ where: { jobId, type: 'APPROVAL_ANSWER' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
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
    await prisma.fleetApproval.deleteMany();
    await prisma.fleetCommand.deleteMany();
    await prisma.pendingAction.deleteMany();
    await prisma.fleetJob.deleteMany();
    await prisma.chatThread.deleteMany();
    await prisma.budgetIncident.deleteMany();
    await prisma.budgetPolicy.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await prisma.fleetActivity.deleteMany();
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
  // AC-1 / AC-2 — a roster-only agent reads the project's approvals
  // -------------------------------------------------------------------------

  it('AC-1: a roster-only agent lists the project approvals (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('p1-approval-roster-agent', 'get', approvalsUrl(P1_SLUG)).expect(200);

    expect(data<{ records: ApprovalItem[] }>(res).records.map((a) => a.id)).toEqual([approval.id]);
  }, TIMEOUT);

  it('AC-2: the roster-only agent reads one approval (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('p1-approval-roster-agent', 'get', approvalsUrl(P1_SLUG, `/${approval.id}`)).expect(200);

    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({ id: approval.id, type: 'nax_bash_escalate', status: 'pending' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 / AC-5 — a DEVELOPER agent decides a bash ask of a user's job
  // -------------------------------------------------------------------------

  it('AC-3: a DEVELOPER agent allows a pending bash ask of a RUNNING job requested by a user (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('p1-approval-dev-agent', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' }).expect(200);

    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow', resolvedBy: 'user' }));
  }, TIMEOUT);

  it('AC-4: that allow creates an APPROVAL_ANSWER command for the job', async () => {
    const { job, approval } = await bashAsk();

    await as('p1-approval-dev-agent', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' }).expect(200);

    const commands = await commandsFor(job.id);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({ runnerId, leaseEpoch: 1, type: 'APPROVAL_ANSWER' }));
    expect(commands[0]?.payload).toEqual(expect.objectContaining({ approvalId: approval.id, naxAskId: approval.naxAskId, choice: 'allow' }));
  }, TIMEOUT);

  it('AC-5: that allow stores decidedById as the agent\'s id', async () => {
    const { approval } = await bashAsk();

    await as('p1-approval-dev-agent', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' }).expect(200);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'approved', decidedById: ids.devAgent }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 / AC-8 / AC-9 — the decide key is chosen per approval type
  // -------------------------------------------------------------------------

  it('AC-6: a viewer binding is refused by the bash decide and the ask stays pending with no command', async () => {
    const { job, approval } = await bashAsk();

    expectPermissionsRefusal(await as('viewerBind', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' }));

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decision: null, decidedById: null }));
    expect(await commandsFor(job.id)).toHaveLength(0);
  }, TIMEOUT);

  it('AC-7: a developer binding is refused by the budget decide and the ask stays pending', async () => {
    const { approval } = await budgetAsk(p1Id);

    expectPermissionsRefusal(await as('devBind', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'keep_paused' }));

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decision: null }));
  }, TIMEOUT);

  it('AC-8: a project-admin binding decides the same budget ask (200)', async () => {
    const { approval } = await budgetAsk(p1Id);

    await as('adminBind', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'keep_paused' }).expect(200);
  }, TIMEOUT);

  it('AC-9: that keep_paused leaves the approval rejected', async () => {
    const { approval } = await budgetAsk(p1Id);

    await as('adminBind', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'keep_paused' }).expect(200);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'rejected', decision: 'keep_paused', decidedById: ids.adminBind }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 — the admin prefix still decides a project's bash ask
  // -------------------------------------------------------------------------

  it('AC-10: a global admin allows a pending bash ask through the admin prefix (200)', async () => {
    const { approval } = await bashAsk();

    const res = await as('root', 'post', `/api/fleet/approvals/${approval.id}/decide`, { decision: 'allow' }).expect(200);

    expect(data<ApprovalItem>(res)).toEqual(expect.objectContaining({ status: 'approved', decision: 'allow' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 / AC-12 — the admin prefix needs a global read grant
  // -------------------------------------------------------------------------

  it('AC-11: a non-admin user is refused by the admin approval list', async () => {
    expectPermissionsRefusal(await as('other', 'get', '/api/fleet/approvals'));
  }, TIMEOUT);

  it('AC-12: a project-admin binding is refused by the admin decide, and the ask stays pending', async () => {
    const { approval } = await budgetAsk(p1Id);

    expectPermissionsRefusal(await as('adminBind', 'post', `/api/fleet/approvals/${approval.id}/decide`, { decision: 'keep_paused' }));

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decision: null }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 — an assistant_action ask keeps its creator-only handler
  // -------------------------------------------------------------------------

  it('AC-13: a user who is not the ask\'s creator is refused with threads.notCreator and it stays pending', async () => {
    expect(NOT_CREATOR).not.toBe('');
    const approval = await assistantAsk(ids.other);

    const res = await as('devBind', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'reject' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(NOT_CREATOR);
    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decision: null }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 .. AC-18 — the counts are filtered by the read key
  // -------------------------------------------------------------------------

  it('AC-14: a developer binding sees only its own project\'s pending approval in the counts', async () => {
    await budgetAsk(p1Id);
    await budgetAsk(p2Id);

    const res = await as('devBind', 'get', '/api/fleet/approval-counts').expect(200);

    expect(data<Counts>(res)).toEqual({ projects: [{ projectId: p1Id, slug: P1_SLUG, pending: 1 }], unscoped: 0, total: 1 });
  }, TIMEOUT);

  it('AC-15: a rostered agent reads the counts (200)', async () => {
    await budgetAsk(p1Id);

    await as('p1-approval-roster-agent', 'get', '/api/fleet/approval-counts').expect(200);
  }, TIMEOUT);

  it('AC-16: that rostered agent\'s counts list p1 with one pending', async () => {
    await budgetAsk(p1Id);

    const res = await as('p1-approval-roster-agent', 'get', '/api/fleet/approval-counts').expect(200);

    expect(data<Counts>(res)).toEqual({ projects: [{ projectId: p1Id, slug: P1_SLUG, pending: 1 }], unscoped: 0, total: 1 });
  }, TIMEOUT);

  it('AC-17: a global admin counts both live projects and not the soft-deleted project\'s approval', async () => {
    await budgetAsk(p1Id);
    await budgetAsk(p2Id);
    await budgetAsk(delId);

    const res = await as('root', 'get', '/api/fleet/approval-counts').expect(200);

    expect(data<Counts>(res)).toEqual({
      projects: [
        expect.objectContaining({ projectId: p1Id, slug: P1_SLUG, pending: 1 }),
        expect.objectContaining({ projectId: p2Id, slug: P2_SLUG, pending: 1 }),
      ],
      unscoped: 0,
      total: 2,
    });
  }, TIMEOUT);

  it('AC-18: a global admin\'s counts include a global policy\'s pending approval in unscoped', async () => {
    await budgetAsk(null);

    const res = await as('root', 'get', '/api/fleet/approval-counts').expect(200);

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

  it('AC-26: a DEVELOPER agent is refused its own job\'s bash ask with the self-decide code', async () => {
    expect(SELF_DECIDE).not.toBe('');
    const { approval } = await bashAsk({ requestedById: ids.devAgent, requestedByType: 'AGENT' });

    const res = await as('p1-approval-dev-agent', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' });

    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(SELF_DECIDE);
  }, TIMEOUT);

  it('AC-27: after that refusal the ask is still pending and no command exists', async () => {
    const { job, approval } = await bashAsk({ requestedById: ids.devAgent, requestedByType: 'AGENT' });

    await as('p1-approval-dev-agent', 'post', approvalsUrl(P1_SLUG, `/${approval.id}/decide`), { decision: 'allow' }).expect(403);

    expect(await reloadApproval(approval.id)).toEqual(expect.objectContaining({ status: 'pending', decision: null, decidedById: null }));
    expect(await commandsFor(job.id)).toHaveLength(0);
  }, TIMEOUT);
});

function projectBudget(): Record<string, unknown> {
  return { scopeType: 'project', windowKind: 'calendar_month_utc', amountUsd: 25 };
}

function globalBudget(): Record<string, unknown> {
  return { scopeType: 'global', windowKind: 'calendar_month_utc', amountUsd: 25 };
}
