import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5b US-004 — the PROJECT thread session job on the anchor repo (PG): a PROJECT send creates a THREAD job on the
 * project's oldest fleet repo (S5b-R13) with project-only instructions, the anchor's id drives the budget gate and the
 * dispatch activity, a project that lost its only fleet repo answers 409 `threads.noFleetRepo` on send (its detail stays
 * 200), and the ingest of the job's `turn_end` line names the cost event after the thread. A REPO send is unchanged.
 *
 * Acceptance setup: FLEET_THREADS_ENABLED=true before boot, `dev` (DEVELOPER) is the thread creator, requests as dev.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-thread-send.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectBindingOnlyFixtures, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { putThreadLines } from '../../helpers/thread-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

interface AnchorProject {
  slug: string;
  projectId: string;
  anchor: { id: string; defaultBranch: string };
  later: { id: string };
}

describeIntegration('fleet project thread send (PG, US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;
  let savedThreadsEnabled: string | undefined;

  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });

  /** A project `dev` is a DEVELOPER of, with one GitHub fleet repo `owner/name`. */
  const seedProject = async (prefix: string, key: string) => {
    const slug = `${prefix}-${++seq}`;
    const project = await prisma.project.create({ data: { name: slug, slug, key: `${key}${seq}` } });
    await grantRole(prisma, { type: 'USER', id: world.ids.dev }, 'developer', project.id);
    return project;
  };

  const seedRepo = (projectId: string, name: string, defaultBranch: string, createdAt?: Date) =>
    prisma.fleetRepo.create({ data: {
      projectId, provider: 'github', owner: 'acme', name, defaultBranch, createdById: world.ids.root,
      ...(createdAt ? { createdAt } : {}),
    } });

  /**
   * A project with two fleet repos and `dev` as DEVELOPER. The later repo is written first, so insertion order cannot
   * stand in for the anchor rule: the anchor is the older `createdAt`, not the first row.
   */
  const seedTwoRepoProject = async (): Promise<AnchorProject> => {
    const project = await seedProject('anchor', 'A');
    const later = await seedRepo(project.id, `later-${seq}`, 'develop', new Date('2026-02-02T00:00:00.000Z'));
    const anchor = await seedRepo(project.id, `anchor-${seq}`, 'trunk', new Date('2026-02-01T00:00:00.000Z'));
    return { slug: project.slug, projectId: project.id, anchor: { id: anchor.id, defaultBranch: anchor.defaultBranch }, later: { id: later.id } };
  };

  const createProjectThread = async (slug: string, title: string): Promise<string> =>
    data<{ id: string }>(await request(server).post(`/api/projects/${slug}/threads`).set(asDev())
      .send({ kind: 'PROJECT', title, backend: { kind: 'native', model: 'm1' } }).expect(201)).id;

  const send = (slug: string, id: string, clientMessageId: string) =>
    request(server).post(`/api/projects/${slug}/threads/${id}/messages`).set(asDev())
      .send({ text: 'Which tickets are blocked?', clientMessageId });

  /** A sent PROJECT thread of a two-repo project: its single THREAD job and that job's turn. */
  const sentProjectThread = async () => {
    const project = await seedTwoRepoProject();
    const threadId = await createProjectThread(project.slug, 'Blocked tickets');
    await send(project.slug, threadId, `cm-${++seq}`).expect(201);
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { threadId, command: 'THREAD' } });
    const turn = await prisma.fleetThreadTurn.findUniqueOrThrow({ where: { jobId: job.id } });
    return { project, threadId, job, turn };
  };

  /** A created PROJECT thread whose project's only fleet repo was deleted afterwards. */
  const projectThreadWithoutRepo = async () => {
    const project = await seedProject('gone', 'G');
    const repo = await seedRepo(project.id, `gone-${seq}`, 'trunk');
    const threadId = await createProjectThread(project.slug, 'Anchor deleted');
    await prisma.fleetRepo.delete({ where: { id: repo.id } });
    return { slug: project.slug, threadId };
  };

  beforeAll(async () => {
    savedThreadsEnabled = process.env['FLEET_THREADS_ENABLED'];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  }, 30_000);

  afterEach(async () => {
    await prisma.budgetPolicy.deleteMany();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (savedThreadsEnabled === undefined) delete process.env['FLEET_THREADS_ENABLED'];
      else process.env['FLEET_THREADS_ENABLED'] = savedThreadsEnabled;
    }
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });

  it('AC-1: a PROJECT send creates a THREAD job on the anchor repo', async () => {
    const { project, job } = await sentProjectThread();
    expect(job.repoId).toBe(project.anchor.id);
    expect(job.repoId).not.toBe(project.later.id);
  });

  it('AC-2: that job refs the anchor repo default branch', async () => {
    const { project, job } = await sentProjectThread();
    expect(job.ref).toBe(project.anchor.defaultBranch);
  });

  it('AC-3: that job carries the thread feature', async () => {
    const { threadId, job } = await sentProjectThread();
    expect(job.feature).toBe(`thread-${threadId}`);
  });

  it('AC-4: the turn instructions name the project', async () => {
    const { project, turn } = await sentProjectThread();
    expect(turn.instructions).toContain(project.slug);
  });

  it('AC-5: the turn instructions never mention write_doc', async () => {
    const { turn } = await sentProjectThread();
    expect(turn.instructions).not.toContain('write_doc');
  });

  it('AC-8: a PROJECT send in a project whose only fleet repo was deleted answers 409 threads.noFleetRepo', async () => {
    const { slug, threadId } = await projectThreadWithoutRepo();
    const res = await send(slug, threadId, `cm-${++seq}`).expect(409);
    expect(res.body.message).toBe('This project has no repository, so a project thread cannot run');
    expect(res.body.ret).not.toBe(0);
  });

  it('AC-9: that refused send creates no FleetJob for the thread', async () => {
    const { slug, threadId } = await projectThreadWithoutRepo();
    const res = await send(slug, threadId, `cm-${++seq}`).expect(409);
    expect(res.body.message).toBe('This project has no repository, so a project thread cannot run');
    expect(await prisma.fleetJob.count({ where: { threadId } })).toBe(0);
    // The refusal runs before the message row is written, so the send leaves nothing behind at all.
    expect(await prisma.chatMessage.count({ where: { threadId } })).toBe(0);
  });

  it('AC-10: GET detail for a PROJECT thread in a project with no fleet repo answers 200', async () => {
    const { slug, threadId } = await projectThreadWithoutRepo();
    const res = await request(server).get(`/api/projects/${slug}/threads/${threadId}`).set(asDev()).expect(200);
    expect(data<{ id: string; kind: string; sendRefusal: string | null }>(res))
      .toMatchObject({ id: threadId, kind: 'PROJECT', sendRefusal: null });
  });

  it('AC-11: a pause on the anchor repo scope refuses the PROJECT send with 409 fleet.budgetPaused', async () => {
    const project = await seedTwoRepoProject();
    const threadId = await createProjectThread(project.slug, 'Paused anchor');
    const policy = await prisma.budgetPolicy.create({ data: {
      scopeType: 'repo', scopeId: project.anchor.id, scopeKey: `repo:${project.anchor.id}`, projectId: project.projectId,
      windowKind: 'calendar_month_utc', amountUsd: new Prisma.Decimal(1), createdById: world.ids.root, updatedById: world.ids.root,
      pausedAt: new Date(), pausedWindowStart: monthStart(new Date()),
    } });
    const res = await send(project.slug, threadId, `cm-${++seq}`).expect(409);
    expect(res.body.message).toContain(policy.id);
    expect(res.body.message).toContain(`repo:${project.anchor.id}`);
    expect(await prisma.fleetJob.count({ where: { threadId } })).toBe(0);
  });

  it('AC-12: the job.dispatched activity of a PROJECT send names the anchor repo', async () => {
    const { project, job } = await sentProjectThread();
    const activity = await prisma.fleetActivity.findFirstOrThrow({ where: { jobId: job.id, action: 'job.dispatched' } });
    expect(activity.payload).toMatchObject({ repoId: project.anchor.id, ref: project.anchor.defaultBranch, command: 'THREAD' });
  });

  it('AC-13: a turn_end cost line for the PROJECT job writes a cost event named thread-<threadId>', async () => {
    const runner = await enrollRunner(server, world.tokens.root, `project-thread-runner-${++seq}`);
    const { project, threadId, job } = await sentProjectThread();
    await prisma.fleetJob.update({ where: { id: job.id }, data: {
      state: 'RUNNING', runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(),
    } });
    await putThreadLines(server, runner.apiKey, { id: job.id, leaseEpoch: 1 }, [
      JSON.stringify({ type: 'turn_start', turnId: 't1' }),
      JSON.stringify({ type: 'turn_end', turnId: 't1', status: 'completed', output: 'Done', usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0.0123 }),
    ]);
    const event = await prisma.fleetCostEvent.findUniqueOrThrow({
      where: { jobId_leaseEpoch_callId: { jobId: job.id, leaseEpoch: 1, callId: 't1:turn_end' } },
    });
    expect(event).toMatchObject({ featureName: `thread-${threadId}`, repoId: project.anchor.id, stage: 'thread' });
    expect(event.costUsd.toString()).toBe('0.0123');
  });

  it('AC-14: a REPO send still creates a THREAD job on the thread repo', async () => {
    const created = data<{ id: string }>(await request(server).post('/api/projects/web/threads').set(asDev())
      .send({ repoId: world.repoId, feature: `repo-send-${++seq}`, title: 'Repo thread', backend: { kind: 'native', model: 'm1' } }).expect(201));
    await send('web', created.id, `cm-${++seq}`).expect(201);
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { threadId: created.id, command: 'THREAD' } });
    expect(job).toMatchObject({ repoId: world.repoId, ref: 'trunk' });
  });
});
