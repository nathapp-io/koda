/**
 * Fleet S5b 1c-b — the PROJECT code notice on a live session, folded from a real `session_started` line over HTTP and
 * read back over HTTP (PG): a PROJECT thread hosted by a runner whose capabilities lack `projectCode` stores
 * `projectCodeUnavailableOn` naming that runner (US-003 AC-9); a runner with `projectCode: true`, and a REPO thread on
 * a runner without it, store no such key (AC-10); a close keeps the notice (AC-11); and
 * `GET /api/projects/:slug/threads/:id` passes it to the client in `data.session` (AC-12).
 *
 * The unit spec next to the ingest repository feeds it a Prisma-shaped fake; this one runs the real upload route, the
 * real fold and the real thread route.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/fleet-project-code-session.integration.spec.ts
 */
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { putThreadLines } from '../../helpers/thread-fixtures';
import type { RunnerCapabilities } from '../../../src/fleet/common/protocol';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED', 'FLEET_SYNC_WAIT_MS'] as const;

/** A v4 thread runner that has koda tools, so `kodaToolsUnavailableOn` can never mask the notice under test. */
const caps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  ...FLEET_CAPS, threadBackends: { native: ['m1'], acp: [] }, threadWrite: true, kodaTools: true, ...over,
});

describeIntegration('fleet project-code session notice (PG + HTTP, S5b 1c-b)', () => {
  let app: NathApplication;
  let artifactDir: string | undefined;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let noCode: { runnerId: string; apiKey: string };
  let withCode: { runnerId: string; apiKey: string };
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });

  /** A RUNNING THREAD job of a PROJECT (or REPO) thread held by `runner` at lease epoch 1, with its SESSION turn. */
  const seedThread = async (runner: { runnerId: string; apiKey: string }, kind: 'PROJECT' | 'REPO', title: string) => {
    const feature = `pc-session-${++seq}`;
    const thread = await prisma.chatThread.create({
      data: {
        projectId: world.projectId, kind,
        repoId: kind === 'PROJECT' ? null : world.repoId,
        baseRef: kind === 'PROJECT' ? null : 'trunk',
        feature: kind === 'PROJECT' ? null : feature,
        title, createdById: world.ids.dev, runnerId: runner.runnerId,
        backend: { kind: 'native', model: 'm1' }, skills: [],
        specPath: kind === 'PROJECT' ? null : `.nax/features/${feature}/spec.md`,
      },
    });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id,
      },
    });
    await prisma.fleetThreadTurn.create({
      data: { jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false },
    });
    return { threadId: thread.id, jobId: job.id, runnerKey: runner.apiKey };
  };

  const SESSION_STARTED = [{ type: 'session_started', at: '2026-10-16T00:00:00.000Z', resumed: false, backend: { kind: 'native' }, skillShas: [] }];
  const put = (job: { jobId: string; runnerKey: string }, lines: object[], offset = 0) =>
    putThreadLines(server, job.runnerKey, { id: job.jobId }, lines.map((line) => JSON.stringify(line)), offset);
  const storedSession = async (threadId: string): Promise<Record<string, unknown>> =>
    (await prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } })).session as Record<string, unknown>;

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true';
    process.env.FLEET_SYNC_WAIT_MS = '0';
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-project-code-'));
    process.env.FLEET_ARTIFACT_DIR = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    noCode = await enrollRunner(server, world.tokens.root, 'pc-no-code', { capabilities: caps() });
    withCode = await enrollRunner(server, world.tokens.root, 'pc-with-code', { capabilities: caps({ projectCode: true }) });
    await prisma.runner.updateMany({
      where: { id: { in: [noCode.runnerId, withCode.runnerId] } },
      data: { protocolVersion: 4, lastSeenAt: new Date(), enabled: true, capacity: 1 },
    });
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('US-003 AC-9: a PROJECT thread on a runner without projectCode stores the notice with the runner name', async () => {
    const job = await seedThread(noCode, 'PROJECT', 'Notice on a code-less runner');

    await put(job, SESSION_STARTED);

    const session = await storedSession(job.threadId);
    expect(session).toMatchObject({ jobId: job.jobId, state: 'live', projectCodeUnavailableOn: 'pc-no-code' });
    expect(session).not.toHaveProperty('kodaToolsUnavailableOn');
  });

  it('US-003 AC-10: a runner with projectCode, and a REPO thread without it, store no notice', async () => {
    const codeThread = await seedThread(withCode, 'PROJECT', 'Code-capable runner');
    const repoThread = await seedThread(noCode, 'REPO', 'Repo thread on a code-less runner');

    await put(codeThread, SESSION_STARTED);
    await put(repoThread, SESSION_STARTED);

    expect(await storedSession(codeThread.threadId)).not.toHaveProperty('projectCodeUnavailableOn');
    expect(await storedSession(repoThread.threadId)).not.toHaveProperty('projectCodeUnavailableOn');
  });

  it('US-003 AC-11: closing the session keeps the notice', async () => {
    const job = await seedThread(noCode, 'PROJECT', 'Notice kept on close');
    const size = await put(job, SESSION_STARTED);

    await put(job, [{ type: 'session_closed', reason: 'idle' }], size);

    expect(await storedSession(job.threadId)).toMatchObject({ state: 'closed', reason: 'idle', projectCodeUnavailableOn: 'pc-no-code' });
  });

  it('US-003 AC-12: GET /api/projects/:slug/threads/:id answers data.session.projectCodeUnavailableOn', async () => {
    const job = await seedThread(noCode, 'PROJECT', 'Notice over HTTP');
    await put(job, SESSION_STARTED);

    const res = await request(server).get(`/api/projects/web/threads/${job.threadId}`).set(asDev()).expect(200);

    expect(data<{ session: Record<string, unknown> }>(res).session).toMatchObject({
      jobId: job.jobId, state: 'live', projectCodeUnavailableOn: 'pc-no-code',
    });
  });
});
