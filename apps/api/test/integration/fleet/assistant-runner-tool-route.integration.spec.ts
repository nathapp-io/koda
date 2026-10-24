/**
 * Fleet S5b US-005 — the runner tool route, the ASSIGN's koda tool descriptors and the tools notice (PG).
 *
 * The route is job-scoped (1b-R1): every call carries `?leaseEpoch=<n>` and a real runner key, so the refusals are
 * driven end to end — runner authentication, the lease fence, the thread gates and the tool lookup. The ASSIGN halves
 * post a real capability report through `POST /api/fleet/runner/sync` (SEAM-4) instead of stubbing a payload, and the
 * notice is read back through `GET /api/projects/web/threads/:id` (SEAM-6). AC-19 needs a line from an ended attempt,
 * which the upload route's fence refuses, so it drives the same catch-up path the API uses at startup
 * (`ThreadIngestor.catchUp`, as `thread-ingest-bootstrap.integration.spec.ts` does).
 *
 * Acceptance setup: FLEET_THREADS_ENABLED=true and FLEET_SYNC_WAIT_MS=0 before boot, project `web` with `dev` as its
 * DEVELOPER and the thread creator. Every runner enrolled by one test is set offline before the next one, so a send's
 * `placeJob` never picks a runner the test did not name.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/assistant-runner-tool-route.integration.spec.ts
 */
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { KODA_TOOL_DESCRIPTORS } from '../../../src/fleet/assistant/koda-tool-descriptors';
import { LOG_STORE, LogStore, logKey } from '../../../src/fleet/logs/log-store';
import { ThreadIngestor } from '../../../src/fleet/threads/ingest/thread-ingestor';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, enrollRunner, seedFleetHttpWorld, syncBody } from '../../helpers/fleet-fixtures';
import { ThreadJobSeed, putThreadLines, seedThreadJobFor } from '../../helpers/thread-fixtures';
import type { AssignPayload, RunnerCapabilities, SyncRequest, SyncResponse } from '../../../src/fleet/common/protocol';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });
const ENV = ['FLEET_ARTIFACT_DIR', 'FLEET_THREADS_ENABLED', 'FLEET_SYNC_WAIT_MS'] as const;

/** A v4 runner that hosts REPO threads; `kodaTools` and `projectThreads` are the S5b opt-ins. */
const threadCaps = (over: Partial<RunnerCapabilities> = {}): RunnerCapabilities => ({
  ...FLEET_CAPS,
  threadBackends: { native: ['m1'], acp: [] },
  threadWrite: true,
  ...over,
});

/** The runner's lastSeenAt value that no placement window accepts (the sync sets its own runner online). */
const OFFLINE_AT = new Date('2020-01-01T00:00:00.000Z');

/** A refusal sentence exactly as `src/i18n/en/<namespace>.json` declares it, with its `{args}` filled in. */
function sentence(key: string, args: Record<string, unknown> = {}): string {
  const [namespace, ...segments] = key.split('.');
  const catalog = JSON.parse(readFileSync(join(__dirname, '../../../src/i18n/en', `${namespace}.json`), 'utf8')) as Record<string, unknown>;
  const value = segments.reduce<unknown>(
    (node, segment) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[segment] : undefined),
    catalog,
  );
  expect(typeof value).toBe('string');
  return (value as string).replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in args ? String(args[name]) : placeholder));
}

describeIntegration('fleet assistant runner tool route (PG, US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let artifactDir: string;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};

  interface EnrolledRunner { runnerId: string; apiKey: string; name: string }
  /** Two enrolled runners for the whole suite (`enroll` is throttled to 10 a minute): one that never advertised
   * `kodaTools`, one that did. Every test seeds jobs on the one its case is about. */
  let plain: EnrolledRunner;
  let koda: EnrolledRunner;

  const body = data;
  const asDev = () => ({ Authorization: `Bearer ${world.tokens.dev}` });
  const config = () => app.get<IFleetConfig>(FLEET_CFG);

  /** Enrolls a runner and puts its row where a v4 sync would: protocol 4, enabled, online, room for every seeded
   * job. The suite shares two runners (the enroll route is throttled to 10 a minute) and each test seeds a RUNNING
   * thread job on one of them, so the syncing runner's thread load accumulates; the capacity has to clear that. */
  const enroll = async (prefix: string, caps: RunnerCapabilities): Promise<EnrolledRunner> => {
    const name = `${prefix}-${++seq}`;
    const runner = await enrollRunner(server, world.tokens.root, name, { capabilities: caps });
    await prisma.runner.update({
      where: { id: runner.runnerId },
      data: { protocolVersion: 4, enabled: true, lastSeenAt: new Date(), capacity: 1, threadCapacity: 64 },
    });
    return { ...runner, name };
  };

  const offlineAllRunners = () => prisma.runner.updateMany({ data: { lastSeenAt: OFFLINE_AT } });

  const toolUrl = (jobId: string, name: string, leaseEpoch?: string | number): string =>
    `/api/fleet/runner/jobs/${jobId}/tools/${name}${leaseEpoch === undefined ? '' : `?leaseEpoch=${leaseEpoch}`}`;

  /** POSTs the route. `leaseEpoch: null` omits the query, `undefined` sends the usual 1. */
  const callTool = (
    apiKey: string,
    jobId: string,
    over: { name?: string; leaseEpoch?: string | number | null; body?: unknown } = {},
  ) => {
    const epoch = over.leaseEpoch === undefined ? 1 : over.leaseEpoch;
    return request(server)
      .post(toolUrl(jobId, over.name ?? 'koda_get_ticket', epoch === null ? undefined : epoch))
      .set({ Authorization: `Bearer ${apiKey}` })
      .send(over.body ?? { toolCallId: 'c1', input: { ref: 'WEB-1' } });
  };

  /** A RUNNING THREAD job of project `web` held by `runner` at lease epoch 1. */
  const threadJob = (runner: EnrolledRunner, feature: string): Promise<ThreadJobSeed> =>
    seedThreadJobFor(prisma, world, runner, { feature });

  const sync = async (apiKey: string, over: Partial<SyncRequest> = {}) =>
    body<SyncResponse>(
      await request(server)
        .post('/api/fleet/runner/sync')
        .set({ Authorization: `Bearer ${apiKey}` })
        .send(syncBody({ protocolVersion: 4, bootId: 'boot-1', freeSlots: 0, ...over }))
        .expect(200),
    );

  const assignOf = (res: SyncResponse, jobId: string): AssignPayload => {
    const command = res.commands.find((c) => c.type === 'ASSIGN' && c.jobId === jobId);
    expect(command).toBeDefined();
    return (command as { payload: AssignPayload }).payload;
  };

  const threadOf = (threadId: string) => prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } });
  const jobOfThread = (threadId: string) => prisma.fleetJob.findFirstOrThrow({ where: { threadId, command: 'THREAD' }, orderBy: { queuedAt: 'desc' } });

  /** The session GET /api/projects/web/threads/:id answers for `dev` (the creator and a DEVELOPER). */
  const readSession = async (threadId: string): Promise<Record<string, unknown> | null> => {
    const res = await request(server).get(`/api/projects/web/threads/${threadId}`).set(asDev()).expect(200);
    return body<{ session: Record<string, unknown> | null }>(res).session;
  };

  /** A REPO thread of project `web` with `dev` as its creator, and a message send that starts its first turn. */
  const repoThreadWithTurn = async (feature: string, clientMessageId: string): Promise<{ threadId: string; jobId: string }> => {
    const threadId = data<{ id: string }>(
      await request(server).post('/api/projects/web/threads').set(asDev())
        .send({ repoId: world.repoId, feature, title: feature, backend: { kind: 'native', model: 'm1' } }).expect(201),
    ).id;
    await request(server).post(`/api/projects/web/threads/${threadId}/messages`).set(asDev())
      .send({ text: 'Which tickets are blocked?', clientMessageId }).expect(201);
    return { threadId, jobId: (await jobOfThread(threadId)).id };
  };

  const sessionStarted = (at: string) => ({ type: 'session_started', at, resumed: false, backend: { kind: 'native' }, skillShas: [] });
  /** PUTs JSONL lines the way the runner's log upload does, through the route's own fence. */
  const put = (s: ThreadJobSeed, lines: object[], leaseEpoch = 1) =>
    putThreadLines(server, s.runnerKey, { id: s.jobId, leaseEpoch }, lines.map((line) => JSON.stringify(line)));

  /** Appends JSONL bytes straight into an attempt's stream, bypassing the upload fence (an attempt already over). */
  const appendStream = async (jobId: string, leaseEpoch: number, lines: object[]): Promise<void> => {
    const store = app.get<LogStore>(LOG_STORE);
    const key = logKey(jobId, leaseEpoch, 'thread');
    const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
    await store.withLock(key, async () => {
      const result = await store.append(key, await store.size(key), bytes);
      if (result.kind !== 'appended') throw new Error(`thread stream write refused: ${result.kind}`);
    });
  };

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    process.env['FLEET_SYNC_WAIT_MS'] = '0';
    artifactDir = mkdtempSync(join(tmpdir(), 'koda-runner-tool-'));
    process.env['FLEET_ARTIFACT_DIR'] = artifactDir;
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    // WEB-1: what the route's happy path reads back.
    await prisma.ticket.create({
      data: {
        projectId: world.projectId, number: 1, type: 'BUG', status: 'IN_PROGRESS', priority: 'HIGH',
        title: 'Fix login page', description: 'The login form rejects valid credentials.', assignedToUserId: world.ids.dev,
      },
    });
    plain = await enroll('route-plain', threadCaps());
    koda = await enroll('route-koda', threadCaps({ kodaTools: true }));
  }, 60_000);

  beforeEach(async () => {
    await offlineAllRunners();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: the holder of a RUNNING THREAD job reads a ticket through the route', async () => {
    const s = await threadJob(plain, 'route-ac1');

    const res = await callTool(plain.apiKey, s.jobId).expect(200);

    expect(body<{ content: string; isError: boolean }>(res)).toMatchObject({ isError: false });
    expect(body<{ content: string }>(res).content).toContain('WEB-1');
  });

  it('AC-2/AC-18: a stale leaseEpoch answers 409 fleet.fence and queues no ABANDON', async () => {
    const s = await threadJob(plain, 'route-ac2');

    const res = await callTool(plain.apiKey, s.jobId, { leaseEpoch: 2 }).expect(409);

    expect(res.body.message).toBe(sentence('fleet.fence.409'));
    expect(await prisma.fleetCommand.count({ where: { jobId: s.jobId, type: 'ABANDON' } })).toBe(0);
  });

  it("AC-3: another enrolled runner's key answers 409 fleet.fence", async () => {
    const s = await threadJob(plain, 'route-ac3');

    const res = await callTool(koda.apiKey, s.jobId, { leaseEpoch: 1 }).expect(409);

    expect(res.body.message).toBe(sentence('fleet.fence.409'));
  });

  it('AC-4: a missing leaseEpoch answers 400 fleet.toolCall', async () => {
    const s = await threadJob(plain, 'route-ac4');

    const res = await callTool(plain.apiKey, s.jobId, { leaseEpoch: null }).expect(400);

    expect(toolUrl(s.jobId, 'koda_get_ticket')).not.toContain('leaseEpoch');
    expect(res.body.message).toBe(sentence('fleet.toolCall.-2', { reason: 'leaseEpoch' }));
  });

  it('AC-5/AC-16/AC-17: a 201-character toolCallId, a non-integer leaseEpoch and a malformed body answer 400', async () => {
    const s = await threadJob(plain, 'route-ac5');

    const long = await callTool(plain.apiKey, s.jobId, { body: { toolCallId: 'c'.repeat(201), input: { ref: 'WEB-1' } } }).expect(400);
    expect(long.body.message).toBe(sentence('fleet.toolCall.-2', { reason: 'toolCallId' }));
    const epoch = await callTool(plain.apiKey, s.jobId, { leaseEpoch: 'abc' }).expect(400);
    expect(epoch.body.message).toBe(sentence('fleet.toolCall.-2', { reason: 'leaseEpoch' }));
    const malformed = await callTool(plain.apiKey, s.jobId, { body: { toolCallId: 42, input: {} } }).expect(400);
    expect(malformed.body.message).toBe(sentence('fleet.toolCall.-2', { reason: 'toolCallId' }));
  });

  it('AC-6: a job id that does not exist answers 404 fleet.jobs', async () => {
    const res = await callTool(plain.apiKey, 'no-such-job').expect(404);

    expect(res.body.message).toBe(sentence('fleet.jobs.404'));
  });

  it('AC-7: an UPLOADING THREAD job answers 409 fleet.jobState', async () => {
    const s = await threadJob(plain, 'route-ac7');
    await prisma.fleetJob.update({ where: { id: s.jobId }, data: { state: 'UPLOADING' } });

    const res = await callTool(plain.apiKey, s.jobId).expect(409);

    expect(res.body.message).toBe(sentence('fleet.jobState.409', { state: 'UPLOADING' }));
  });

  it('AC-8: a THREAD_CLOSE pending at the job epoch answers 409 threads.closing', async () => {
    const s = await threadJob(plain, 'route-ac8');
    await request(server).post(`/api/projects/web/threads/${s.threadId}/end-session`).set(asDev()).send({}).expect(200);

    const res = await callTool(plain.apiKey, s.jobId).expect(409);

    expect(res.body.message).toBe(sentence('threads.closing.409'));
    expect(await prisma.fleetCommand.count({ where: { jobId: s.jobId, type: 'THREAD_CLOSE' } })).toBe(1);
  });

  it('AC-9: a RUNNING RUN job answers 409 fleet.notThreadJob', async () => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'feat/run', command: 'RUN', feature: `route-${++seq}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'RUNNING', runnerId: plain.runnerId, leaseEpoch: 1, firstStartedAt: new Date(),
      },
    });

    const res = await callTool(plain.apiKey, job.id).expect(409);

    expect(res.body.message).toBe(sentence('fleet.notThreadJob.409'));
  });

  it('AC-10: with FLEET_THREADS_ENABLED off the route answers 409 threads.disabled', async () => {
    const s = await threadJob(plain, 'route-ac10');
    config().threadsEnabled = false;
    try {
      const res = await callTool(plain.apiKey, s.jobId).expect(409);
      expect(res.body.message).toBe(sentence('threads.disabled.409'));
    } finally {
      config().threadsEnabled = true;
    }
  });

  it('AC-11: an unknown tool answers 404 fleet.assistantTool', async () => {
    const s = await threadJob(plain, 'route-ac11');

    const res = await callTool(plain.apiKey, s.jobId, { name: 'koda_drop_tables' }).expect(404);

    expect(res.body.message).toBe(sentence('fleet.assistantTool.404'));
  });

  it('AC-1 (replay): the same (jobId, toolCallId) answers the stored result', async () => {
    const s = await threadJob(plain, 'route-replay');

    const first = await callTool(plain.apiKey, s.jobId).expect(200);
    const second = await callTool(plain.apiKey, s.jobId).expect(200);

    expect(body<{ content: string }>(second).content).toBe(body<{ content: string }>(first).content);
    expect(await prisma.assistantToolCall.count({ where: { jobId: s.jobId, toolCallId: 'c1' } })).toBe(1);
  });

  it('AC-12: a sync from a kodaTools runner returns the ASSIGN with the descriptor catalog in order', async () => {
    const { jobId } = await repoThreadWithTurn('assign-koda', 'assign-koda-1');

    const res = await sync(koda.apiKey, { capabilities: threadCaps({ kodaTools: true, projectThreads: true }) });

    const thread = assignOf(res, jobId).thread as { kodaTools: Array<{ name: string }> };
    expect(thread.kodaTools.map((tool) => tool.name)).toEqual(KODA_TOOL_DESCRIPTORS.map((tool) => tool.name));
  });

  it('AC-13: a SESSION ASSIGN on a runner without kodaTools carries no kodaTools key', async () => {
    const { jobId } = await repoThreadWithTurn('assign-plain', 'assign-plain-1');

    const res = await sync(plain.apiKey, { capabilities: threadCaps({ projectThreads: true }) });

    const thread = assignOf(res, jobId).thread as Record<string, unknown>;
    expect(thread.action).toBe('SESSION');
    expect(thread).not.toHaveProperty('kodaTools');
  });

  it('AC-13: a PUBLISH ASSIGN on a runner with kodaTools carries no kodaTools key', async () => {
    const threadId = data<{ id: string }>(
      await request(server).post('/api/projects/web/threads').set(asDev())
        .send({ repoId: world.repoId, feature: 'assign-publish', title: 'Publish assign', backend: { kind: 'native', model: 'm1' } }).expect(201),
    ).id;
    await prisma.chatThread.update({ where: { id: threadId }, data: { runnerId: koda.runnerId, writtenPaths: ['docs/a.md'] } });
    // The runner is online for Publish's own gate (threads.runnerOffline) and then placed by the publish itself.
    await prisma.runner.update({ where: { id: koda.runnerId }, data: { lastSeenAt: new Date() } });
    const { jobId } = data<{ jobId: string }>(
      await request(server).post(`/api/projects/web/threads/${threadId}/publish`).set(asDev()).send({}).expect(200),
    );
    expect(await prisma.fleetThreadTurn.findUniqueOrThrow({ where: { jobId } })).toMatchObject({ action: 'PUBLISH' });

    const res = await sync(koda.apiKey, { capabilities: threadCaps({ kodaTools: true }) });

    const thread = assignOf(res, jobId).thread as Record<string, unknown>;
    expect(thread.action).toBe('PUBLISH');
    expect(thread).not.toHaveProperty('kodaTools');
  });

  it('AC-14: a session started without kodaTools names its runner on the thread session', async () => {
    const s = await threadJob(plain, 'notice-ac14');

    await put(s, [sessionStarted('2026-10-15T00:00:00.000Z')]);

    expect(await readSession(s.threadId)).toMatchObject({
      jobId: s.jobId, state: 'live', kodaToolsUnavailableOn: plain.name,
    });
  });

  it('AC-15: a session started on a kodaTools runner carries no notice key', async () => {
    const s = await threadJob(koda, 'notice-ac15');

    await put(s, [sessionStarted('2026-10-15T00:00:00.000Z')]);

    const session = await readSession(s.threadId);
    expect(session).toMatchObject({ jobId: s.jobId, state: 'live' });
    expect(session).not.toHaveProperty('kodaToolsUnavailableOn');
  });

  it('AC-19: a stale session_started of an ended attempt leaves the live session unchanged', async () => {
    const s = await threadJob(plain, 'notice-ac19');
    await put(s, [sessionStarted('2026-10-15T00:00:00.000Z')]);
    const live = await readSession(s.threadId);
    expect(live).toMatchObject({ jobId: s.jobId, state: 'live' });
    // An earlier attempt of the same thread that is already over: its line arrives through the startup catch-up.
    const ended = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${s.threadId}`,
        profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
        state: 'COMPLETED', stateReason: 'crashed', runnerId: plain.runnerId, leaseEpoch: 1, threadId: s.threadId,
        finishedAt: new Date(), firstStartedAt: new Date(),
      },
    });
    await appendStream(ended.id, 1, [sessionStarted('2026-10-14T00:00:00.000Z')]);

    // `ThreadIngestBootstrap` runs the startup catch-up, so the direct call carries the thread component.
    await withTestActor({ type: 'SYSTEM', id: 'thread' }, () => app.get(ThreadIngestor).catchUp(ended.id, 1));

    expect(await readSession(s.threadId)).toEqual(live);
    expect(await threadOf(s.threadId)).toMatchObject({ session: live });
  });
});
