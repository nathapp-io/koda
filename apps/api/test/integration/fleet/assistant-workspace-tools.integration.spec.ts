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
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import type { ToolResult } from '../../../src/fleet/assistant/assistant-tool.types';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor, type ThreadJobSeed } from '../../helpers/thread-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
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

  const createProject = (slug: string, name: string) =>
    prisma.project.create({ data: { name, slug, key: slug.toUpperCase() } });

  const createUser = (email: string) =>
    prisma.user.create({ data: { email, passwordHash: 'x', role: 'MEMBER' } });

  const member = (projectId: string, userId: string) =>
    prisma.projectMember.create({ data: { projectId, userId, role: 'DEVELOPER' } });

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
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    executor = app.get(AssistantToolExecutor, { strict: false });
    world = await seedFleetHttpWorld(server, prisma);

    const a = await createProject('a', 'Alpha');
    const b = await createProject('b', 'Bravo');
    await createProject('c', 'Charlie');
    const bTwo = await createProject('b-two', 'Bravo Two');
    const aOne = await createProject('a-one', 'Alpha One');
    const rich = await createProject('rich', 'Rich');
    richSlug = rich.slug;
    // A soft-deleted project `dev` holds a member row for: it must never be listed (AC-7).
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

    // AC-5: one pending and one approved approval.
    await prisma.fleetApproval.createMany({
      data: [
        { type: 'nax_bash_escalate', status: 'pending', projectId: rich.id, payload: {}, requestedAt: new Date(now - DAY_MS) },
        { type: 'nax_bash_escalate', status: 'approved', projectId: rich.id, payload: {}, requestedAt: new Date(now - DAY_MS) },
      ],
    });

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
