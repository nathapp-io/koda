import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S5a US-001 — web-facing thread facts (PG): `GET /projects/:slug/threads/:id` answers the
 * first send refusal (or null), `GET /projects/:slug/threads` answers `threadsEnabled`, and
 * `GET /projects/:slug/fleet/runners` summaries carry `threadBackends`.
 *
 * Acceptance setup: app.get(FLEET_CFG).threadsEnabled = true, project `web`, member `dev`
 * (DEVELOPER) who created thread T on the project's fleet repo, maxCostUsd 5 and costUsd 0,
 * no runner pinned and no THREAD job; requests as dev unless the AC says otherwise.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/thread-facts.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { enrollRunner, FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet thread facts (PG, US-001)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let seq = 0;

  const cfg = () => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const asViewer = () => ({ Authorization: `Bearer ${world.tokens.viewer}` });

  /** A blank thread: created by dev on the web project's repo, maxCostUsd 5, costUsd 0, no runner, no job. */
  const newThread = async (over: Record<string, unknown> = {}): Promise<string> => {
    const feature = `web-facts-${++seq}`;
    const thread = await prisma.chatThread.create({ data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature, title: 'Thread facts',
      createdById: world.ids.dev, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: `.nax/features/${feature}/spec.md`, maxCostUsd: '5', costUsd: '0', ...over,
    } });
    return thread.id;
  };

  /** A THREAD job of the thread in the given state, no runner held (the refusal facts never read job.runnerId). */
  const threadJob = (threadId: string, over: Record<string, unknown> = {}) => prisma.fleetJob.create({ data: {
    projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`,
    profiles: [], selectorLabels: [], maxCostUsd: '5', requestedById: world.ids.dev,
    threadId, state: 'RUNNING', leaseEpoch: 1, ...over,
  } });

  const getThread = (id: string) => (token: string) =>
    request(server).get(`/api/projects/web/threads/${id}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    cfg().threadsEnabled = true;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-001 AC1: answers sendRefusal null for a thread nothing blocks', async () => {
    const id = await newThread();
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ id: string; sendRefusal: unknown }>(res).sendRefusal).toBeNull();
  });

  it('US-001 AC2: answers sendRefusal disabled while the kill switch is off', async () => {
    const id = await newThread();
    cfg().threadsEnabled = false;
    try {
      const res = await getThread(id)(world.tokens.dev).expect(200);
      expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('disabled');
    } finally {
      cfg().threadsEnabled = true;
    }
  });

  it('US-001 AC3: answers sendRefusal archived after the thread is archived', async () => {
    const id = await newThread();
    const archived = await request(server).post(`/api/projects/web/threads/${id}/archive`)
      .set(asDev()).send({}).expect(200);
    expect(data<{ status: string; sendRefusal: string | null }>(archived))
      .toMatchObject({ status: 'ARCHIVED', sendRefusal: 'archived' });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ status: string; sendRefusal: string | null }>(res))
      .toMatchObject({ status: 'ARCHIVED', sendRefusal: 'archived' });
  });

  it('US-001 AC4: answers sendRefusal costCap when costUsd reaches maxCostUsd', async () => {
    const id = await newThread({ costUsd: '5' });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('costCap');
  });

  it('US-001 AC5: answers sendRefusal closing while the current job uploads', async () => {
    const id = await newThread();
    await threadJob(id, { state: 'UPLOADING' });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('closing');
  });

  it('US-001 AC6: answers sendRefusal closing when a THREAD_CLOSE is queued for the running job epoch', async () => {
    const id = await newThread();
    const job = await threadJob(id, { state: 'RUNNING', leaseEpoch: 1 });
    const runner = await prisma.runner.create({ data: {
      name: `close-runner-${++seq}`, apiKeyHash: `close-hash-${seq}`, os: 'linux', arch: 'x64', labels: [],
      capabilities: { nax: { version: '0.83.0', protocols: ['native'] } }, daemonVersion: '0.1.0',
      protocolVersion: 4, bootId: 'close-boot', lastSeenAt: new Date(), createdById: world.ids.root,
    } });
    await prisma.fleetCommand.create({ data: {
      runnerId: runner.id, jobId: job.id, type: 'THREAD_CLOSE', leaseEpoch: 1, payload: {},
    } });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('closing');
  });

  it('US-001 AC7: answers sendRefusal turnRunning while a user message is pending and the job runs', async () => {
    const id = await newThread();
    await threadJob(id, { state: 'RUNNING', leaseEpoch: 1 });
    await prisma.chatMessage.create({ data: {
      threadId: id, seq: 1, role: 'user', authorUserId: world.ids.dev, content: 'hi', status: 'pending',
    } });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('turnRunning');
  });

  it('US-001 AC8: answers the same costCap refusal to a VIEWER member (viewer-independent)', async () => {
    const id = await newThread({ costUsd: '5' });
    const res = await getThread(id)(world.tokens.viewer).expect(200);
    expect(data<{ sendRefusal: string | null }>(res).sendRefusal).toBe('costCap');
  });

  it('US-001 AC9: answers threadsEnabled false on the list while the kill switch is off', async () => {
    cfg().threadsEnabled = false;
    try {
      const res = await request(server).get('/api/projects/web/threads').set(asDev()).expect(200);
      expect(data<{ items: unknown[]; threadsEnabled: boolean }>(res).threadsEnabled).toBe(false);
    } finally {
      cfg().threadsEnabled = true;
    }
  });

  it('US-001 write-path AC-14: GET the thread returns writtenPaths, publishedSha, specPublished and lastWrite unchanged', async () => {
    const sha = 'b'.repeat(40);
    const lastWrite = { kind: 'published', jobId: 'j1', at: '2026-10-15T00:00:00.000Z', sha, paths: ['docs/a.md'], ignored: [] };
    const id = await newThread({ writtenPaths: ['docs/a.md'], publishedSha: sha, specPublished: true, lastWrite });
    const res = await getThread(id)(world.tokens.dev).expect(200);
    expect(data<Record<string, unknown>>(res)).toMatchObject({ writtenPaths: ['docs/a.md'], publishedSha: sha, specPublished: true, lastWrite });
  });

  it('US-001 AC14: project runner summaries carry a protocol-4 runner threadBackends', async () => {
    const enrolled = await enrollRunner(server, world.tokens.root, 'facts-runner');
    await prisma.runner.update({ where: { id: enrolled.runnerId }, data: {
      protocolVersion: 4, enabled: true, lastSeenAt: new Date(),
      capabilities: { nax: { version: '0.83.0', protocols: ['native'] }, threadBackends: { native: ['m1'], acp: [] } },
    } });
    const page = data<{ records: Array<Record<string, unknown>> }>(
      await request(server).get('/api/projects/web/fleet/runners').set(asDev()).expect(200),
    );
    const summary = page.records.find((record) => record.id === enrolled.runnerId);
    expect(summary).toBeDefined();
    expect((summary as Record<string, unknown>).threadBackends).toEqual({ native: ['m1'], acp: [] });
  });
});