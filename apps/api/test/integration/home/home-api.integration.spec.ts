import { canRunDbTests } from '../../helpers/test-environment';
import { randomUUID } from 'node:crypto';
/**
 * UX redesign slice 2 — GET /home (PG): cross-project scoping, needs-you contents, agent 403.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/home/home-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { expectBindingOnlyFixtures, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';
import { HOME_LIMITS } from '../../../src/home/home.types';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

interface HomeSnapshot {
  generatedAt: string;
  needsYou: {
    tickets: Array<{ id: string; ref: string; projectSlug: string; status: string }>;
    ticketsTotal: number;
    approvals: Array<{ id: string; permissionKey: string; type: string | null; projectId: string | null; projectSlug: string | null; jobId: string | null; requestedAt: string }>;
    approvalsTotal: number;
    jobs: Array<{ id: string; state: string; reason: string; pendingApprovals: number }>;
    jobsTotal: number;
  };
  projects: Array<{ slug: string; openTickets: number; attentionJobs: number }>;
  activity: Array<{ eventType: string; projectSlug: string; action: string }>;
}

describeIntegration('home dashboard API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let webId: string;
  let opsId: string;
  let ticketNo = 0;
  /** The two engine requests the needs-you section lists (permissions P3 US-011). */
  let bashAsk: { requestId: string };
  let budgetAsk: { requestId: string };
  let budgetAskWithoutDelegate: { requestId: string };
  let opsBashAsk: { requestId: string };

  const seedAgentCreate = (projectId: string) => prisma.approvalRequest.create({
    data: {
      permissionKey: 'agent.create', projectId, actorType: 'AGENT', actorId: 'agent-create-actor', origin: 'rest',
      correlationId: randomUUID(), input: {}, inputHash: randomUUID(), requiredMode: 'human',
      onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false,
      expiresAt: new Date(Date.now() + 60_000),
    },
    select: { id: true },
  });

  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const home = async (who: keyof FleetHttpWorld['tokens']) =>
    data<HomeSnapshot>(await request(server).get('/api/home').set(auth(who)).expect(200));

  const ticket = (projectId: string, over: Partial<Prisma.TicketUncheckedCreateInput> = {}) =>
    prisma.ticket.create({
      data: { projectId, number: ++ticketNo, type: 'BUG', title: `t${ticketNo}`, ...over },
    });

  const job = (projectId: string, repoId: string, over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId, ref: 'main', command: 'RUN', profiles: ['fast'], maxCostUsd: new Prisma.Decimal(2),
        selectorLabels: [], requestedById: world.ids.root, feature: 'f', ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    webId = world.projectId;
    opsId = world.opsProjectId;

    // Tickets: two open in web assigned to dev, one closed, one open in ops (dev is not a member).
    await ticket(webId, { status: 'IN_PROGRESS', priority: 'HIGH', assignedToUserId: world.ids.dev });
    await ticket(webId, { status: 'CREATED', assignedToUserId: world.ids.dev });
    await ticket(webId, { status: 'CLOSED', assignedToUserId: world.ids.dev });
    await ticket(opsId, { status: 'IN_PROGRESS', assignedToUserId: world.ids.dev });

    // Jobs: a failed one in web, a QUEUED web job blocked by a pending approval, a failed one in ops
    // (root sees it, dev must not), and a failure older than the 7-day window (history, not needs-you).
    const now = new Date();
    await job(webId, world.repoId, { feature: 'failed-recent', state: 'FAILED', finishedAt: new Date(now.getTime() - 3_600_000), stateReason: 'tests_red' });
    // Permissions P3 US-011: `/home` lists the ask of the job's requester, so the blocked job is dev's own.
    const blocked = await job(webId, world.repoId, {
      feature: 'blocked-on-approval', state: 'QUEUED', queuedAt: new Date(now.getTime() - 7_200_000), requestedById: world.ids.dev,
    });
    await job(opsId, world.foreignRepoId, { feature: 'failed-ops', state: 'FAILED', finishedAt: new Date(now.getTime() - 1_800_000) });
    await job(webId, world.repoId, { feature: 'failed-old', state: 'FAILED', finishedAt: new Date(now.getTime() - 8 * 86_400_000) });

    // Permissions P3 US-011: the asks are engine requests with a `FleetApprovalAsk` link. `requestedAt` is the
    // request's `createdAt`, the job comes from the link, and a budget ask may own no project.
    bashAsk = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: webId, createdAt: new Date(now.getTime() - 3_600_000), onBehalfOf: { type: 'USER', id: world.ids.dev },
      input: { jobId: blocked.id, leaseEpoch: 1, naxAskId: 'ask-home-bash', payload: { command: 'bun run test', commandTruncated: false, options: ['allow'] } },
      link: { jobId: blocked.id, leaseEpoch: 1, naxAskId: 'ask-home-bash' },
    });
    budgetAsk = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: null, createdAt: new Date(now.getTime() - 1_800_000),
      input: {
        policyId: 'policy-home', scopeType: 'global', scopeId: null, windowKind: 'day',
        windowStart: new Date(now.getTime() - 86_400_000).toISOString(), spentUsd: '10.5', amountUsd: '20',
        requestedAt: new Date(now.getTime() - 1_800_000).toISOString(),
      },
      link: { budgetPolicyId: 'policy-home' },
    });
    budgetAskWithoutDelegate = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: webId, createdAt: new Date(now.getTime() - 900_000),
      input: { policyId: 'policy-home-web', scopeType: 'project', scopeId: webId, windowKind: 'day',
        windowStart: now.toISOString(), spentUsd: '1', amountUsd: '2', requestedAt: now.toISOString() },
      link: { budgetPolicyId: 'policy-home-web' },
    });
    opsBashAsk = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: opsId, createdAt: new Date(now.getTime() - 600_000),
      input: { jobId: 'ops-job', leaseEpoch: 1, naxAskId: 'ask-home-ops', payload: {} },
      link: { jobId: 'ops-job', leaseEpoch: 1, naxAskId: 'ask-home-ops' },
    });

    // Activity across the three timeline tables, plus one event in ops.
    await prisma.ticketEvent.create({ data: { projectId: webId, action: 'STATUS_CHANGE', actorId: world.ids.dev, actorType: 'user', source: 'api' } });
    await prisma.agentEvent.create({ data: { projectId: webId, agentId: 'agent-x', action: 'CODE_INDEXED', actorId: 'agent-x', source: 'internal' } });
    await prisma.decisionEvent.create({ data: { projectId: webId, agentId: 'agent-x', action: 'decided', decision: 'decided', source: 'internal' } });
    await prisma.ticketEvent.create({ data: { projectId: opsId, action: 'CREATED', actorId: world.ids.root, actorType: 'user', source: 'api' } });

    // A soft-deleted project never shows, whatever its grants say.
    const gone = await prisma.project.create({
      data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date() },
    });
    // Permissions P1 US-004: the project grant is a role binding, not a legacy membership row.
    await grantRole(prisma, { type: 'USER', id: world.ids.dev }, 'project-admin', gone.id);
    await ticket(gone.id, { status: 'IN_PROGRESS', assignedToUserId: world.ids.dev });
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('AC-2: an Approver for web sees web asks and excludes project ops', async () => {
    await grantRole(prisma, { type: 'USER', id: world.ids.viewer }, 'approver', webId);
    await app.get(PermissionCache).invalidate();
    const v = await home('viewer');
    expect(v.needsYou.approvals.map((a) => a.projectId)).toEqual([webId, webId]);
    expect(v.needsYou.approvals.some((a) => a.id === opsBashAsk.requestId)).toBe(false);
  });

  it('scopes a member to their projects: web only, with web-only needs-you', async () => {
    const v = await home('dev');
    expect(v.projects.map((p) => [p.slug, p.openTickets, p.attentionJobs])).toEqual([['web', 2, 2]]);
    expect(v.needsYou.tickets.map((t) => t.status).sort()).toEqual(['CREATED', 'IN_PROGRESS']);
    expect(v.needsYou.ticketsTotal).toBe(2);
    expect(v.needsYou.approvals).toHaveLength(1); // only the bash ask; asks without onBehalfOf are not theirs
    expect(v.needsYou.approvalsTotal).toBe(1);
    expect(v.needsYou.approvals.some((a) => a.id === budgetAskWithoutDelegate.requestId)).toBe(false);
    expect(v.needsYou.approvals.some((a) => a.id === opsBashAsk.requestId)).toBe(false);
    expect(v.needsYou.jobs.map((j) => [j.reason, j.state]).sort()).toEqual([['blocked', 'QUEUED'], ['failed', 'FAILED']]);
    expect(v.needsYou.jobsTotal).toBe(2); // ops failure and the 8-day-old failure are out of scope
    expect(v.activity.every((e) => e.projectSlug === 'web')).toBe(true);
    expect(v.activity.map((e) => e.eventType).sort()).toEqual(['agent_event', 'decision_event', 'ticket_event']);
  });

  it("US-011 AC-9: the job requester's home lists the pending ask with its request id and the link's job", async () => {
    const v = await home('dev');

    expect(v.needsYou.approvals).toEqual([
      expect.objectContaining({
        id: bashAsk.requestId, type: 'nax_bash_escalate', projectSlug: 'web',
        jobId: v.needsYou.jobs.find((j) => j.reason === 'blocked')?.id,
      }),
    ]);
    // The ask is the blocked job's, so the row it blocks carries the count.
    expect(v.needsYou.jobs.find((j) => j.reason === 'blocked')?.pendingApprovals).toBe(1);
  });

  it('AC-1: global admin home labels non-fleet and fleet requests and matches approvals list IDs', async () => {
    const agentRequest = await seedAgentCreate(webId);
    const v = await home('root');
    const agentRow = v.needsYou.approvals.find((a) => a.id === agentRequest.id);
    const bashRow = v.needsYou.approvals.find((a) => a.id === bashAsk.requestId);
    expect(agentRow).toMatchObject({ type: null, permissionKey: 'agent.create' });
    expect(bashRow).toMatchObject({ type: 'nax_bash_escalate', permissionKey: 'fleet.job.shell.escalate', jobId: expect.any(String) });
    const listed = data<{ records: Array<{ id: string }> }>(await request(server).get('/api/approvals?status=pending').set(auth('root')).expect(200));
    expect(new Set(v.needsYou.approvals.map((a) => a.id))).toEqual(new Set(listed.records.map((r) => r.id)));
    await prisma.approvalRequest.delete({ where: { id: agentRequest.id } });
  });

  it('gives a global admin every live project plus unscoped approvals', async () => {
    const v = await home('root');
    expect(v.projects.map((p) => p.slug).sort()).toEqual(['ops', 'web']);
    const ops = v.projects.find((p) => p.slug === 'ops');
    // The counts are project-wide: ops holds the one open ticket assigned to dev (a project dev cannot see).
    expect(ops).toMatchObject({ openTickets: 1, attentionJobs: 1 });
    expect(v.needsYou.approvalsTotal).toBe(4); // visible bash and budget asks across both projects plus unscoped budget
    expect(v.needsYou.approvals.find((a) => a.projectSlug === null)).toMatchObject({
      type: 'budget_override_required', permissionKey: 'fleet.budget.override', projectId: null,
    });
    expect(v.needsYou.jobsTotal).toBe(3);
    expect(v.needsYou.jobs.find((j) => j.id === v.needsYou.approvals.find((a) => a.id === bashAsk.requestId)?.jobId))
      .toMatchObject({ reason: 'blocked', pendingApprovals: expect.any(Number) });
    expect(v.needsYou.jobs.find((j) => j.id === v.needsYou.approvals.find((a) => a.id === bashAsk.requestId)?.jobId)?.pendingApprovals).toBeGreaterThanOrEqual(1);
    expect(v.activity.some((e) => e.projectSlug === 'ops')).toBe(true);
  });

  it('US-011 AC-10: the admin approvals count includes the pending budget ask that has no project', async () => {
    const v = await home('root');

    expect(v.needsYou.approvalsTotal).toBe(4);
    expect(v.needsYou.approvals.map((a) => a.id)).toEqual([
      opsBashAsk.requestId, budgetAskWithoutDelegate.requestId, budgetAsk.requestId, bashAsk.requestId,
    ]);
    expect(v.needsYou.approvals.map((a) => a.requestedAt)).toEqual(
      [...v.needsYou.approvals].map((a) => a.requestedAt).sort((a, b) => b.localeCompare(a)),
    );
    expect(v.needsYou.approvals.length).toBeLessThanOrEqual(HOME_LIMITS.approvals);
  });

  it('returns an empty snapshot for a signed-in user with no memberships', async () => {
    const v = await home('outsider');
    expect(v.projects).toEqual([]);
    expect(v.needsYou).toMatchObject({ tickets: [], ticketsTotal: 0, approvals: [], approvalsTotal: 0, jobs: [], jobsTotal: 0 });
    expect(v.activity).toEqual([]);
  });

  it('403s an agent key', async () => {
    const agentKey = (await import('../../helpers/fleet-fixtures')).seedFleetHttpAgent;
    const agent = await agentKey(server, world.tokens.root);
    await request(server).get('/api/home').set({ Authorization: `Bearer ${agent.apiKey}` }).expect(403);
  });
});
