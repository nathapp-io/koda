/**
 * UX redesign slice 2 — GET /home (PG): cross-project scoping, needs-you contents, agent 403.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/home/home-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface HomeSnapshot {
  generatedAt: string;
  needsYou: {
    tickets: Array<{ id: string; ref: string; projectSlug: string; status: string }>;
    ticketsTotal: number;
    approvals: Array<{ id: string; type: string; projectSlug: string | null }>;
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
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
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
    const blocked = await job(webId, world.repoId, { feature: 'blocked-on-approval', state: 'QUEUED', queuedAt: new Date(now.getTime() - 7_200_000) });
    await job(opsId, world.foreignRepoId, { feature: 'failed-ops', state: 'FAILED', finishedAt: new Date(now.getTime() - 1_800_000) });
    await job(webId, world.repoId, { feature: 'failed-old', state: 'FAILED', finishedAt: new Date(now.getTime() - 8 * 86_400_000) });

    await prisma.fleetApproval.create({
      data: { type: 'nax_bash_escalate', projectId: webId, jobId: blocked.id, payload: {}, requestedAt: new Date(now.getTime() - 3_600_000) },
    });
    await prisma.fleetApproval.create({
      data: { type: 'budget_override_required', payload: {}, requestedAt: new Date(now.getTime() - 1_800_000) },
    });

    // Activity across the three timeline tables, plus one event in ops.
    await prisma.ticketEvent.create({ data: { projectId: webId, action: 'STATUS_CHANGE', actorId: world.ids.dev, actorType: 'user', source: 'api' } });
    await prisma.agentEvent.create({ data: { projectId: webId, agentId: 'agent-x', action: 'CODE_INDEXED', actorId: 'agent-x', source: 'internal' } });
    await prisma.decisionEvent.create({ data: { projectId: webId, agentId: 'agent-x', action: 'decided', decision: 'decided', source: 'internal' } });
    await prisma.ticketEvent.create({ data: { projectId: opsId, action: 'CREATED', actorId: world.ids.root, actorType: 'user', source: 'api' } });

    // A soft-deleted project never shows, whatever its membership rows say.
    const gone = await prisma.project.create({
      data: { name: 'gone', slug: 'gone', key: 'GONE', deletedAt: new Date(), members: { create: { userId: world.ids.dev, role: 'ADMIN' } } },
    });
    await ticket(gone.id, { status: 'IN_PROGRESS', assignedToUserId: world.ids.dev });
  });

  afterAll(async () => {
    await app.close();
  });

  it('scopes a member to their projects: web only, with web-only needs-you', async () => {
    const v = await home('dev');
    expect(v.projects.map((p) => [p.slug, p.openTickets, p.attentionJobs])).toEqual([['web', 2, 2]]);
    expect(v.needsYou.tickets.map((t) => t.status).sort()).toEqual(['CREATED', 'IN_PROGRESS']);
    expect(v.needsYou.ticketsTotal).toBe(2);
    expect(v.needsYou.approvals).toHaveLength(1); // the bash ask; the unscoped budget ask is not theirs
    expect(v.needsYou.approvalsTotal).toBe(1);
    expect(v.needsYou.jobs.map((j) => [j.reason, j.state]).sort()).toEqual([['blocked', 'QUEUED'], ['failed', 'FAILED']]);
    expect(v.needsYou.jobsTotal).toBe(2); // ops failure and the 8-day-old failure are out of scope
    expect(v.activity.every((e) => e.projectSlug === 'web')).toBe(true);
    expect(v.activity.map((e) => e.eventType).sort()).toEqual(['agent_event', 'decision_event', 'ticket_event']);
  });

  it('gives a global admin every live project plus unscoped approvals', async () => {
    const v = await home('root');
    expect(v.projects.map((p) => p.slug).sort()).toEqual(['ops', 'web']);
    const ops = v.projects.find((p) => p.slug === 'ops');
    // The counts are project-wide: ops holds the one open ticket assigned to dev (a project dev cannot see).
    expect(ops).toMatchObject({ openTickets: 1, attentionJobs: 1 });
    expect(v.needsYou.approvalsTotal).toBe(2); // bash ask + unscoped budget ask
    expect(v.needsYou.approvals.find((a) => a.projectSlug === null)).toMatchObject({ type: 'budget_override_required' });
    expect(v.needsYou.jobsTotal).toBe(3);
    expect(v.activity.some((e) => e.projectSlug === 'ops')).toBe(true);
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
