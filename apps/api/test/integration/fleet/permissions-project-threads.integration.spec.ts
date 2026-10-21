/**
 * Permissions P1 US-002 — the fourteen project thread routes decide with catalog keys, ownership comes
 * from the keys (`canOperate`), and input that steers a live turn belongs to the turn's requester
 * (AC-1 .. AC-13, AC-15 .. AC-17, over real HTTP and real Postgres).
 *
 * Every caller below has exactly one kind of source in `p1`: one PROJECT-scope binding (users, no
 * `ProjectMember` row anywhere) or one legacy `AgentProject` roster row plus a binding (agents). No test
 * asserts through a bypass: the refusals are the routes' and the repository's own.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/permissions-project-threads.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { FLEET_CAPS } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;
/** `threads.sessionOtherPrincipal.409`, the live-session refusal this story adds. */
const SESSION_OTHER = (readI18n('threads')['sessionOtherPrincipal'] as Record<string, string>)['409'] as string;

interface ThreadBody { id: string; status: string; maxCostUsd: string; createdByType: string }

describeIntegration('project thread keys and ownership (US-002)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let config: IFleetConfig;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let repoId = '';
  let n = 0;

  const as = (who: string, method: 'get' | 'post' | 'patch', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set({ Authorization: `Bearer ${tokens[who]}` });
    return body === undefined ? req : req.send(body);
  };
  const threadsUrl = (suffix = '') => `/api/projects/${P1_SLUG}/threads${suffix}`;

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };
  const expectSessionOtherPrincipal = (res: request.Response): void => {
    expect(res.status).toBe(409);
    expect(res.body).toEqual(expect.objectContaining({ ret: 409, message: SESSION_OTHER }));
  };

  const createUser = async (who: string): Promise<void> => {
    resetThrottle(app);
    const created = await as('root', 'post', '/api/admin/users', {
      email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201);
    ids[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (principal: { type: 'USER' | 'AGENT'; id: string }, roleKey: string): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId: p1Id }, { type: 'SYSTEM', id: 'test' });

  const createUserWithBinding = async (who: string, roleKey: string): Promise<void> => {
    await createUser(who);
    await bind({ type: 'USER', id: ids[who] }, roleKey);
  };

  /** An agent whose only source in p1 is one binding: a roster row plus that binding, and no agent role. */
  const createAgent = async (slug: string, roleKey: string): Promise<string> => {
    const created = await as('root', 'post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    tokens[slug] = body.apiKey;
    await prisma.agentProject.create({ data: { agentId: body.agent.id, projectId: p1Id } });
    await bind({ type: 'AGENT', id: body.agent.id }, roleKey);
    // The rows are written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** A thread of p1, created by `createdById` directly (its creator never runs a create route here). */
  const threadRow = (over: Record<string, unknown> = {}) => {
    const feature = `f-${(n += 1)}`;
    return prisma.chatThread.create({ data: {
      projectId: p1Id, kind: 'REPO', repoId, baseRef: 'trunk', feature, title: feature, createdById: ids.other,
      backend: { kind: 'native', model: 'm1' }, skills: [], specPath: `.nax/features/${feature}/spec.md`, ...over,
    } });
  };

  /** An online runner advertising threadWrite, as Publish, Discard and a live session require. */
  const runner = () => prisma.runner.create({ data: {
    name: `thread-runner-${(n += 1)}`, apiKeyHash: `thread-runner-hash-${n}`, os: 'linux', arch: 'x64', labels: ['linux'],
    capacity: 2, capabilities: { ...FLEET_CAPS, threadWrite: true },
    daemonVersion: '0.1.0', protocolVersion: 4, bootId: `thread-boot-${n}`, enabled: true, lastSeenAt: new Date(),
    createdById: ids.root,
  } });

  /** A RUNNING THREAD job of the thread, with its turn: a live session unless `action` says otherwise. */
  const liveJob = async (threadId: string, runnerId: string, over: Record<string, unknown> = {}) => {
    const job = await prisma.fleetJob.create({ data: {
      projectId: p1Id, repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById: ids.other, requestedByType: 'USER', threadId,
      runnerId, state: 'RUNNING', leaseEpoch: 7, ...over,
    } });
    await prisma.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId, action: 'SESSION', initialMessageId: null, instructions: '',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return job;
  };

  const reload = (id: string) => prisma.chatThread.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);
    // Thread routes are behind the kill switch; every other thread suite sets it the same way.
    config = app.get<IFleetConfig>(FLEET_CFG);
    config.threadsEnabled = true;

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    ids.root = (await prisma.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    // `other` owns the threads the binding-only callers act on; `devBind`, `viewerBind` and `adminBind`
    // each hold one PROJECT-scope binding in p1 and no `ProjectMember` row.
    await createUser('other');
    const project = await as('root', 'post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    // No GitHub installation: the send path's repository-context read answers `no installation` without a forge call.
    repoId = (await prisma.fleetRepo.create({ data: {
      projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: ids.root,
    } })).id;

    await createUserWithBinding('devBind', 'developer');
    await createUserWithBinding('viewerBind', 'viewer');
    await createUserWithBinding('adminBind', 'project-admin');
    ids.agent = await createAgent('p1-thread-agent', 'developer');
  }, BOOT_TIMEOUT);

  afterAll(async () => { await app?.close(); });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 / AC-3 — thread.create
  // -------------------------------------------------------------------------

  const projectThreadBody = () => ({ kind: 'PROJECT', title: 'Brainstorm', backend: { kind: 'native', model: 'm1' } });

  it('AC-1: a user whose only source in p1 is a viewer binding is refused the create with the permissions code', async () => {
    expect(await prisma.projectMember.count({ where: { userId: ids.viewerBind } })).toBe(0);

    expectPermissionsRefusal(await as('viewerBind', 'post', threadsUrl(), projectThreadBody()));

    expect(await prisma.chatThread.count({ where: { projectId: p1Id } })).toBe(0);
  }, TIMEOUT);

  it('AC-2: a user whose only source in p1 is a developer binding creates a PROJECT thread (201)', async () => {
    const res = await as('devBind', 'post', threadsUrl(), projectThreadBody()).expect(201);

    const thread = data<ThreadBody>(res);
    expect(await reload(thread.id)).toEqual(expect.objectContaining({ createdById: ids.devBind, createdByType: 'USER', kind: 'PROJECT' }));
  }, TIMEOUT);

  it('AC-3: an agent whose only source in p1 is a developer binding creates a PROJECT thread as an AGENT', async () => {
    const res = await as('p1-thread-agent', 'post', threadsUrl(), projectThreadBody()).expect(201);

    const thread = data<ThreadBody>(res);
    expect(thread).toEqual(expect.objectContaining({ createdByType: 'AGENT' }));
    expect(await reload(thread.id)).toEqual(expect.objectContaining({ createdById: ids.agent, createdByType: 'AGENT' }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 — thread.read
  // -------------------------------------------------------------------------

  it('AC-4: a user whose only source in p1 is a viewer binding reads another user\'s thread and its messages (200)', async () => {
    const thread = await threadRow();
    await prisma.chatMessage.create({ data: { threadId: thread.id, seq: 1, role: 'user', authorUserId: ids.other, content: 'hi', status: 'complete' } });

    const list = await as('viewerBind', 'get', threadsUrl('?size=100')).expect(200);
    expect(data<{ items: Array<{ id: string }> }>(list).items.map((item) => item.id)).toContain(thread.id);

    const detail = await as('viewerBind', 'get', threadsUrl(`/${thread.id}`)).expect(200);
    expect(data<{ id: string }>(detail).id).toBe(thread.id);

    const messages = await as('viewerBind', 'get', threadsUrl(`/${thread.id}/messages`)).expect(200);
    expect(data<{ items: Array<{ content: string }> }>(messages).items.map((item) => item.content)).toEqual(['hi']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 / AC-6 / AC-11 / AC-12 — thread.message.send
  // -------------------------------------------------------------------------

  it('AC-5: a user whose only source in p1 is a project-admin binding sends on another user\'s idle thread, and the turn is theirs', async () => {
    const thread = await threadRow();

    const res = await as('adminBind', 'post', threadsUrl(`/${thread.id}/messages`), { text: 'hello', clientMessageId: 'admin-send' }).expect(201);

    const result = data<{ message: { authorUserId: string }, jobId: string }>(res);
    expect(result.message.authorUserId).toBe(ids.adminBind);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: result.jobId } }))
      .toEqual(expect.objectContaining({ requestedById: ids.adminBind, requestedByType: 'USER' }));
  }, TIMEOUT);

  it('AC-6: the creator steers its own live session, and a THREAD_INPUT is created for that job', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ createdById: ids.devBind, runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.devBind });

    const res = await as('devBind', 'post', threadsUrl(`/${thread.id}/messages`), { text: 'next step', clientMessageId: 'creator-send' }).expect(201);

    const message = data<{ message: { id: string } }>(res).message;
    expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(1);
    await expect(prisma.fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_INPUT' } })).resolves.toEqual([
      expect.objectContaining({ runnerId: runnerRow.id, leaseEpoch: 7, payload: { messageId: message.id, text: 'next step' } }),
    ]);
  }, TIMEOUT);

  it('AC-11: a project-admin binding cannot message into another principal\'s live session (409 threads.sessionOtherPrincipal)', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.other });

    expectSessionOtherPrincipal(await as('adminBind', 'post', threadsUrl(`/${thread.id}/messages`), { text: 'intrude', clientMessageId: 'intrude' }));

    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  }, TIMEOUT);

  it('AC-12: a creator whose only source in p1 is now a viewer binding can no longer message its own thread (403 permissions)', async () => {
    // `viewerBind` created this thread earlier in its life; its only source in p1 is a viewer binding today.
    const thread = await threadRow({ createdById: ids.viewerBind });

    expectPermissionsRefusal(await as('viewerBind', 'post', threadsUrl(`/${thread.id}/messages`), { text: 'hello', clientMessageId: 'demoted' }));

    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 — the .own keys keep the creator compare
  // -------------------------------------------------------------------------

  it('AC-7: a developer binding cannot change the cap of another user\'s thread, and the cap is unchanged', async () => {
    const thread = await threadRow({ maxCostUsd: '5' });

    expectPermissionsRefusal(await as('devBind', 'patch', threadsUrl(`/${thread.id}`), { maxCostUsd: 3 }));

    expect((await reload(thread.id)).maxCostUsd.toString()).toBe('5');
  }, TIMEOUT);

  it('AC-8: a developer binding cannot message another user\'s thread, and no message is stored', async () => {
    const thread = await threadRow();

    expectPermissionsRefusal(await as('devBind', 'post', threadsUrl(`/${thread.id}/messages`), { text: 'hello', clientMessageId: 'dev-send' }));

    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
  }, TIMEOUT);

  it('the developer still edits the cap of its own thread', async () => {
    const thread = await threadRow({ createdById: ids.devBind, maxCostUsd: '5' });

    const res = await as('devBind', 'patch', threadsUrl(`/${thread.id}`), { maxCostUsd: 4 }).expect(200);

    expect(data<ThreadBody>(res).maxCostUsd).toBe('4');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 / AC-10 — the any-row keys reach another user's thread
  // -------------------------------------------------------------------------

  it('AC-9: a project-admin binding stops another user\'s live turn, and a THREAD_STOP_TURN is created', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.other });

    await as('adminBind', 'post', threadsUrl(`/${thread.id}/stop`)).expect(200);

    await expect(prisma.fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).resolves.toEqual([
      expect.objectContaining({ runnerId: runnerRow.id, leaseEpoch: 7, payload: {} }),
    ]);
  }, TIMEOUT);

  it('AC-10: a project-admin binding archives another user\'s thread, and the thread becomes ARCHIVED', async () => {
    const thread = await threadRow();

    const res = await as('adminBind', 'post', threadsUrl(`/${thread.id}/archive`)).expect(200);

    expect(data<ThreadBody>(res).status).toBe('ARCHIVED');
    expect((await reload(thread.id)).status).toBe('ARCHIVED');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 — an answer and an in-session publish belong to the session's requester
  // -------------------------------------------------------------------------

  it('AC-13: a project-admin binding cannot answer or publish into another principal\'s live session, and no command is created', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id, writtenPaths: ['docs/a.md'], pendingQuestion: { requestId: 'q1' } });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.other });

    expectSessionOtherPrincipal(await as('adminBind', 'post', threadsUrl(`/${thread.id}/answer`), { requestId: 'q1', text: 'yes' }));
    expectSessionOtherPrincipal(await as('adminBind', 'post', threadsUrl(`/${thread.id}/publish`)));

    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-15 — plan dispatches as its caller
  // -------------------------------------------------------------------------

  it('AC-15: a project-admin binding plans another user\'s published thread, and the PLAN job is theirs', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id, specPublished: true });

    const res = await as('adminBind', 'post', threadsUrl(`/${thread.id}/plan`), {}).expect(201);

    const plan = data<{ job: { id: string } }>(res).job;
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: plan.id } }))
      .toEqual(expect.objectContaining({ command: 'PLAN', requestedById: ids.adminBind, requestedByType: 'USER', threadId: thread.id }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // The rest of the "G + S" table: every any-row holder route, not only the ones an AC names
  // -------------------------------------------------------------------------

  it('a project-admin binding closes another user\'s live session (thread.end-session), and a THREAD_CLOSE is created', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.other });

    await as('adminBind', 'post', threadsUrl(`/${thread.id}/end-session`)).expect(200);

    await expect(prisma.fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_CLOSE' } })).resolves.toEqual([
      expect.objectContaining({ runnerId: runnerRow.id, leaseEpoch: 7 }),
    ]);
  }, TIMEOUT);

  it('a project-admin binding discards another user\'s idle thread, and the DISCARD job is theirs', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id });

    const res = await as('adminBind', 'post', threadsUrl(`/${thread.id}/discard`)).expect(200);

    const discard = data<{ jobId: string }>(res).jobId;
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: discard } }))
      .toEqual(expect.objectContaining({ command: 'THREAD', requestedById: ids.adminBind, requestedByType: 'USER' }));
    expect(await prisma.fleetThreadTurn.findUniqueOrThrow({ where: { jobId: discard } }))
      .toEqual(expect.objectContaining({ action: 'DISCARD' }));
  }, TIMEOUT);

  it('a project-admin binding runs another user\'s planned thread, and the RUN job is theirs', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id, specPublished: true });
    await prisma.fleetJob.create({ data: {
      projectId: p1Id, repoId, ref: 'feat/planned', command: 'PLAN', feature: thread.feature, planFrom: thread.specPath,
      profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: ids.other, threadId: thread.id, state: 'COMPLETED',
    } });

    const res = await as('adminBind', 'post', threadsUrl(`/${thread.id}/run`), {}).expect(201);

    const run = data<{ job: { id: string } }>(res).job;
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: run.id } }))
      .toEqual(expect.objectContaining({ command: 'RUN', requestedById: ids.adminBind, requestedByType: 'USER', threadId: thread.id }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-16 / AC-17 — the .own holder and the non-holder
  // -------------------------------------------------------------------------

  it('AC-16: a developer whose only stopping grant is thread.stop.own cannot stop another principal\'s thread', async () => {
    const runnerRow = await runner();
    const thread = await threadRow({ runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.other });

    expectPermissionsRefusal(await as('devBind', 'post', threadsUrl(`/${thread.id}/stop`)));

    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
    expect(await prisma.fleetJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(expect.objectContaining({ state: 'RUNNING' }));
  }, TIMEOUT);

  it('AC-17: a viewer binding holds none of the write keys, so the guard refuses every project thread write before the handler', async () => {
    const runnerRow = await runner();
    // The caller's own thread, in the state each route would act on: a passing guard would succeed.
    const thread = await threadRow({
      createdById: ids.viewerBind, runnerId: runnerRow.id, writtenPaths: ['docs/a.md'], pendingQuestion: { requestId: 'q1' },
    });
    const job = await liveJob(thread.id, runnerRow.id, { requestedById: ids.viewerBind });

    for (const [suffix, body] of [
      ['stop', {}], ['end-session', {}], ['answer', { requestId: 'q1', text: 'yes' }], ['archive', {}],
      ['publish', {}], ['discard', {}], ['plan', {}], ['run', {}],
      ['messages', { text: 'hello', clientMessageId: 'viewer-send' }],
    ] as const) {
      expectPermissionsRefusal(await as('viewerBind', 'post', threadsUrl(`/${thread.id}/${suffix}`), body));
    }
    expectPermissionsRefusal(await as('viewerBind', 'patch', threadsUrl(`/${thread.id}`), { maxCostUsd: 3 }));

    // Nothing the handlers would have written happened.
    expect(await prisma.fleetCommand.count({ where: { jobId: job.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(1);
    expect(await reload(thread.id)).toEqual(expect.objectContaining({ status: 'ACTIVE' }));
    expect((await reload(thread.id)).maxCostUsd.toString()).toBe('5');
  }, TIMEOUT);
});
