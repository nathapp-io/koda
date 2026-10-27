import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b workspace tools US-003 (1d2-D7) — `koda_my_projects` and the workspace-scoped tool route against PG.
 *
 * The executor halves seed a WORKSPACE thread per creator and drive the real tool through `AssistantToolExecutor`,
 * so the reachable-project rule (`findAllForPrincipal`), the ordering, the three counts and the audit row are the
 * API's own. The route halves (AC-12, AC-13) enroll a runner and seed a RUNNING REPO and a RUNNING WORKSPACE THREAD
 * job on it, so the two refusals enter at `POST /fleet/runner/jobs/:jobId/tools/:name` (SEAM US-002 → US-003).
 *
 * Acceptance setup: FLEET_THREADS_ENABLED=true before boot; home project is `world.projectId` (slug `web`).
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/assistant-workspace-tools.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import type { ToolResult } from '../../../src/fleet/assistant/assistant-tool.types';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, type ThreadJobSeed } from '../../helpers/thread-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const DAY_MS = 86_400_000;

describeIntegration('koda_my_projects and workspace-scoped tools (PG, US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let executor: AssistantToolExecutor;
  let world: FleetHttpWorld;
  let savedThreadsFlag: string | undefined;
  let seq = 0;

  /** The projects each creator reaches: `dev` is a member of a and b, `rich` of rich, `none` of nothing. */
  let devJob: string;
  let orderedJob: string;
  let richJob: string;
  let noneJob: string;
  let adminJob: string;
  let richSlug: string;
  /** The `rich` project's pending fleet ask (permissions P3 US-011 AC-11). */
  let richPendingAsk: string;
  /** The ids of the users the setup creates, so the sentinel can name every one of them. */
  const createdUserIds: string[] = [];

  const createProject = (slug: string, name: string) =>
    prisma.project.create({ data: { name, slug, key: slug.toUpperCase() } });

  const createUser = async (email: string) => {
    const user = await prisma.user.create({ data: { email, passwordHash: 'x' } });
    await grantBaseline(prisma, { type: 'USER', id: user.id });
    createdUserIds.push(user.id);
    return user;
  };

  const member = (projectId: string, userId: string) =>
    grantRole(prisma, { type: 'USER', id: userId }, 'developer', projectId);

  /** A WORKSPACE thread of the home project, created by `userId`, with a RUNNING THREAD job on it. */
  async function workspaceJob(userId: string): Promise<string> {
    const thread = await prisma.chatThread.create({
      data: {
        kind: 'WORKSPACE', projectId: world.projectId, title: `ws-${++seq}`, createdById: userId,
        backend: { kind: 'native', model: 'm1' } as Prisma.InputJsonValue, skills: [],
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: userId,
        state: 'RUNNING', threadId: thread.id,
      },
    });
    return job.id;
  }

  const call = (jobId: string, toolCallId: string, input: unknown): Promise<ToolResult> =>
    executor.execute({ jobId, toolCallId, name: 'koda_my_projects', input });

  /** The one line `koda_my_projects` answered for `slug`; fails loudly when the project is not listed. */
  function lineOf(content: string, slug: string): string {
    const line = content.split('\n').find((row) => row.startsWith(`${slug} open_tickets:`));
    expect(line).toBeDefined();
    return line as string;
  }

  /** Whether the answer lists `slug` at all. */
  const lists = (content: string, slug: string): boolean =>
    content.split('\n').some((row) => row.startsWith(`${slug} open_tickets:`));

  const job = (projectId: string, userId: string, state: string, feature: string, finishedAt: Date) =>
    prisma.fleetJob.create({
      data: {
        projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature, profiles: [], selectorLabels: [],
        maxCostUsd: new Prisma.Decimal(1), requestedById: userId, state, finishedAt,
      },
    });

  beforeAll(async () => {
    savedThreadsFlag = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    executor = app.get(AssistantToolExecutor, { strict: false });
    world = await seedFleetHttpWorld(server, prisma);

    const a = await createProject('a', 'Alpha');
    const b = await createProject('b', 'Bravo');
    await createProject('c', 'Charlie');
    const bTwo = await createProject('b-two', 'Bravo Two');
    const aOne = await createProject('a-one', 'Alpha One');
    const rich = await createProject('rich', 'Rich');
    richSlug = rich.slug;
    // A soft-deleted project `dev` holds a developer binding for: it must never be listed (AC-7).
    const deleted = await prisma.project.create({
      data: { name: 'Retired', slug: 'retired', key: 'RETIRED', deletedAt: new Date() },
    });

    const dev = await createUser('ws-dev@koda.test');
    const ordered = await createUser('ws-ordered@koda.test');
    const richUser = await createUser('ws-rich@koda.test');
    const none = await createUser('ws-none@koda.test');
    await Promise.all([
      member(a.id, dev.id), member(b.id, dev.id), member(deleted.id, dev.id),
      member(bTwo.id, ordered.id), member(aOne.id, ordered.id),
      member(rich.id, richUser.id),
    ]);

    // AC-3: one ticket per status, plus a soft-deleted IN_PROGRESS one that must not count.
    let number = 0;
    for (const status of ['CREATED', 'VERIFIED', 'IN_PROGRESS', 'VERIFY_FIX', 'CLOSED', 'REJECTED']) {
      await prisma.ticket.create({
        data: {
          projectId: rich.id, number: ++number, type: 'TASK', title: `${status} ticket`, status,
          createdByUserId: richUser.id,
        },
      });
    }
    await prisma.ticket.create({
      data: {
        projectId: rich.id, number: ++number, type: 'TASK', title: 'Deleted ticket', status: 'IN_PROGRESS',
        createdByUserId: richUser.id, deletedAt: new Date(),
      },
    });

    // AC-4: two of the four finished jobs are inside the 7-day window and failed.
    const now = Date.now();
    await job(rich.id, richUser.id, 'FAILED', 'failed-2d', new Date(now - 2 * DAY_MS));
    await job(rich.id, richUser.id, 'CRASHED', 'crashed-1d', new Date(now - 1 * DAY_MS));
    await job(rich.id, richUser.id, 'FAILED', 'failed-8d', new Date(now - 8 * DAY_MS));
    await job(rich.id, richUser.id, 'COMPLETED', 'completed-today', new Date(now));

    // AC-5, US-011 AC-11: one pending and one approved fleet ask, plus a pending request of another key that
    // is not a fleet ask. Permissions P3 US-011: the count reads the engine, so only the first counts.
    const pendingAsk = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: rich.id,
      input: { jobId: 'job-ask-rich', leaseEpoch: 1, naxAskId: 'ask-rich-pending', payload: { command: 'ls', commandTruncated: false, options: ['allow'] } },
      link: { jobId: 'job-ask-rich', leaseEpoch: 1, naxAskId: 'ask-rich-pending' },
    });
    await seedFleetAsk(prisma, {
      kind: 'bash', projectId: rich.id, status: 'executed',
      input: { jobId: 'job-ask-rich', leaseEpoch: 1, naxAskId: 'ask-rich-approved', payload: { command: 'ls', commandTruncated: false, options: ['allow'] } },
      link: { jobId: 'job-ask-rich', leaseEpoch: 1, naxAskId: 'ask-rich-approved' },
      decisions: [{ deciderType: 'USER', deciderId: richUser.id, decision: 'approve', params: { choice: 'allow' } }],
    });
    await prisma.approvalRequest.create({
      data: {
        permissionKey: 'ticket.delete', projectId: rich.id, actorType: 'USER', actorId: richUser.id, origin: 'rest',
        correlationId: 'corr-rich-delete', input: { ticketId: 'ticket-rich' }, inputHash: 'hash-rich-delete',
        requiredMode: 'human', onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false,
        status: 'pending', expiresAt: new Date(now + DAY_MS),
      },
    });
    richPendingAsk = pendingAsk.requestId;

    devJob = await workspaceJob(dev.id);
    orderedJob = await workspaceJob(ordered.id);
    richJob = await workspaceJob(richUser.id);
    noneJob = await workspaceJob(none.id);
    // AC-6: root is a global ADMIN with no ProjectMember row anywhere.
    adminJob = await workspaceJob(world.ids.root);
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (savedThreadsFlag === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = savedThreadsFlag;
    }
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
      ...createdUserIds.map((id) => ({ type: 'USER' as const, id })),
    ]);
  });

  it('AC-1: a creator who is a member of a and b reads /a and /b and not /c', async () => {
    const result = await call(devJob, 'ac1', {});

    expect(result.isError).toBe(false);
    expect(lineOf(result.content, 'a')).toMatch(/\/a$/);
    expect(lineOf(result.content, 'b')).toMatch(/\/b$/);
    expect(result.content).not.toMatch(/\/c$/m);
  });

  it('AC-2: the project lines are slug-ascending, so a-one comes before b-two', async () => {
    const result = await call(orderedJob, 'ac2', {});

    const rows = result.content.split('\n').filter((row) => row.includes(' open_tickets: '));
    expect(rows[0]).toMatch(/^a-one open_tickets: \d+ failed_jobs_7d: \d+ pending_approvals: \d+ \/a-one$/);
    expect(rows[1]).toMatch(/^b-two open_tickets: \d+ failed_jobs_7d: \d+ pending_approvals: \d+ \/b-two$/);
  });

  it('AC-3: four open statuses count and the soft-deleted ticket does not', async () => {
    const result = await call(richJob, 'ac3', {});

    expect(lineOf(result.content, richSlug)).toContain('open_tickets: 4');
  });

  it('AC-4: only FAILED and CRASHED jobs finished inside 7 days count', async () => {
    const result = await call(richJob, 'ac4', {});

    expect(lineOf(result.content, richSlug)).toContain('failed_jobs_7d: 2');
  });

  it('AC-5: only the pending approval counts', async () => {
    const result = await call(richJob, 'ac5', {});

    expect(lineOf(result.content, richSlug)).toContain('pending_approvals: 1');
  });

  it('US-011 AC-11: the pending count is the fleet ask alone, not a pending ticket.delete request', async () => {
    // The project holds three ask-shaped rows: one pending fleet ask, one approved fleet ask and one pending
    // `ticket.delete` request (seeded above). Two are pending; only the fleet one is a pending approval.
    const ask = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: richPendingAsk }, select: { projectId: true } });
    expect(await prisma.approvalRequest.count({ where: { projectId: ask.projectId, status: 'pending' } })).toBe(2);

    const result = await call(richJob, 'ac11', {});

    expect(lineOf(result.content, richSlug)).toContain('pending_approvals: 1');
  });

  it('AC-6: a global ADMIN with no member row in c reads /c', async () => {
    const result = await call(adminJob, 'ac6', {});

    expect(result.isError).toBe(false);
    expect(lineOf(result.content, 'c')).toMatch(/\/c$/);
  });

  it('AC-7: a soft-deleted project the creator is a member of is not listed', async () => {
    const result = await call(devJob, 'ac7', {});

    expect(lineOf(result.content, 'a')).toMatch(/\/a$/);
    expect(lists(result.content, 'retired')).toBe(false);
  });

  it('AC-10: a creator with no project at all reads no projects', async () => {
    expect(await call(noneJob, 'ac10', {})).toEqual({ content: 'no projects', isError: false });
  });

  it('AC-15: the audited row of a workspace call names the thread home project', async () => {
    await call(devJob, 'ac15', {});

    const row = await prisma.assistantToolCall.findUnique({
      where: { jobId_toolCallId: { jobId: devJob, toolCallId: 'ac15' } },
    });
    expect(row).toMatchObject({ projectId: world.projectId, outcome: 'ok', tool: 'koda_my_projects', isError: false });
  });

  describe('the runner tool route', () => {
    let runner: { runnerId: string; apiKey: string };
    let repoThread: ThreadJobSeed;
    let workspaceThread: ThreadJobSeed;

    const post = (seed: ThreadJobSeed, toolCallId: string, input: unknown) =>
      request(server)
        .post(`/api/fleet/runner/jobs/${seed.jobId}/tools/koda_my_projects?leaseEpoch=1`)
        .set({ Authorization: `Bearer ${seed.runnerKey}` })
        .send({ toolCallId, input });

    beforeAll(async () => {
      runner = await enrollRunner(server, world.tokens.root, 'ws-tools-runner');
      repoThread = await seedThreadJobFor(prisma, world, runner, { kind: 'REPO', feature: `ws-route-repo-${++seq}` });
      workspaceThread = await seedThreadJobFor(prisma, world, runner, { kind: 'WORKSPACE', feature: `ws-route-ws-${++seq}` });
    }, 60_000);

    it('AC-12: a REPO thread job answers the workspace-only refusal', async () => {
      const res = await post(repoThread, 'ac12', {}).expect(200);

      expect(data<ToolResult>(res)).toEqual({
        content: 'invalid_input: koda_my_projects is only available in workspace threads',
        isError: true,
      });
    });

    it('AC-13: a WORKSPACE thread job with a project key answers invalid_input: project', async () => {
      const res = await post(workspaceThread, 'ac13', { project: 'a' }).expect(200);

      expect(data<ToolResult>(res)).toEqual({ content: 'invalid_input: project', isError: true });
    });
  });
});
