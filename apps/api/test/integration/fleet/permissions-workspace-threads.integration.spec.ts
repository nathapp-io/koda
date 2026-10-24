import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-003 — the ten workspace thread routes decide with catalog keys while the
 * caller-owned workspace fence and the home-project hosting check stay (`AC-1 .. AC-9`, `AC-11`,
 * over real HTTP and real Postgres).
 *
 * Every caller below has exactly one kind of source in `p1`: one PROJECT-scope binding (users, no
 * `ProjectMember` row anywhere) or the roster's viewer binding plus a binding (agents). The
 * workspace routes carry no project slug, so the six workspace keys are decided by `RequiresGuard`
 * against the caller's global keys, and the four `S` routes (`PATCH`, `stop`, `end-session`,
 * `answer`) are decided by `WorkspaceThreadsService` in the thread's home project, on the thread's
 * creator. No test asserts through a bypass: the refusals are the routes' and the service's own.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/permissions-workspace-threads.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, type IFleetConfig } from '../../../src/config/fleet.config';
import { MembershipService } from '../../../src/permissions/membership.service';
import type { PrincipalRef } from '../../../src/permissions/permissions.types';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { FLEET_CAPS } from '../../helpers/fleet-fixtures';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
const P2_SLUG = 'p2';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const P2_KEY = 'PTWO';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;

const readI18n = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, unknown>;

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'] as string;
/** `threads.notFound.404`, the workspace fence's answer to anyone but the creator. */
const THREAD_NOT_FOUND = (readI18n('threads')['notFound'] as Record<string, string>)['404'] as string;

interface ThreadBody { id: string; status: string; maxCostUsd: string; createdByType: string; homeProject: { slug: string } }

/** The three keys the custom GLOBAL role grants: create, read-own and send-own, and nothing else. */
const WORKSPACE_AGENT_KEYS = ['thread.workspace.create', 'thread.workspace.read.own', 'thread.workspace.message.send.own'];

describeIntegration('workspace thread keys and hosting (US-003)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;
  let config: IFleetConfig;

  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let p1Id = '';
  let p2Id = '';
  let p1RepoId = '';
  let n = 0;

  const as = (who: string, method: 'get' | 'post' | 'patch', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set({ Authorization: `Bearer ${tokens[who]}` });
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };
  /** The workspace fence's answer: 404, the same sentence for another user's thread and a missing one. */
  const expectNotFound = (res: request.Response): void => {
    expect(res.status).toBe(404);
    expect(res.body.ret).toBe(404);
    expect(res.body.message).toBe(THREAD_NOT_FOUND);
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

  /** The binding that is the caller's only source in the project. */
  const bind = (principal: PrincipalRef, roleKey: string, projectId: string | null): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId }, { type: 'SYSTEM', id: 'test' });

  /** An agent with a real API key, its project bindings and its baseline; no legacy `AgentRoleEntry`. */
  const createAgent = async (slug: string, roster: string[], bindings: Array<{ roleKey: string; projectId: string | null }>): Promise<string> => {
    resetThrottle(app);
    const created = await as('root', 'post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    tokens[slug] = body.apiKey;
    await grantBaseline(prisma, { type: 'AGENT', id: body.agent.id });
    for (const projectId of roster) await grantRole(prisma, { type: 'AGENT', id: body.agent.id }, 'viewer', projectId);
    for (const binding of bindings) await bind({ type: 'AGENT', id: body.agent.id }, binding.roleKey, binding.projectId);
    // The rows are written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  /** A custom role row (the roles API is US-005's subject, so the fixture writes it). */
  const globalRole = (key: string, permissions: string[]) =>
    prisma.role.create({ data: { key, name: key, description: '', scope: 'GLOBAL', system: false, locked: false, permissions } });

  /** A workspace thread of the project, created by `createdById` (the create routes have their own ACs). */
  const threadRow = (createdById: string, over: Record<string, unknown> = {}) => {
    const title = `ws-${(n += 1)}`;
    return prisma.chatThread.create({ data: {
      projectId: p1Id, kind: 'WORKSPACE', repoId: null, baseRef: null, feature: null, title, createdById,
      backend: { kind: 'native', model: 'm1' }, skills: [], ...over,
    } });
  };

  /** An online runner advertising threadWrite, as a live session requires. */
  const runner = () => prisma.runner.create({ data: {
    name: `ws-thread-runner-${(n += 1)}`, apiKeyHash: `ws-thread-runner-hash-${n}`, os: 'linux', arch: 'x64', labels: ['linux'],
    capacity: 2, capabilities: { ...FLEET_CAPS, threadWrite: true },
    daemonVersion: '0.1.0', protocolVersion: 4, bootId: `ws-thread-boot-${n}`, enabled: true, lastSeenAt: new Date(),
    createdById: ids.root,
  } });

  /** A RUNNING THREAD job of the thread with its SESSION turn: the live turn `stop` targets. */
  const liveJob = async (threadId: string, runnerId: string, requestedById: string) => {
    const job = await prisma.fleetJob.create({ data: {
      projectId: p1Id, repoId: p1RepoId, ref: 'trunk', command: 'THREAD', feature: `thread-${threadId}`, profiles: [],
      maxCostUsd: 5, selectorLabels: [], requestedById, requestedByType: 'USER', threadId,
      runnerId, state: 'RUNNING', leaseEpoch: 7,
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

    const p1 = await as('root', 'post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(p1).id;
    const p2 = await as('root', 'post', '/api/projects', { name: 'P2', slug: P2_SLUG, key: P2_KEY }).expect(201);
    p2Id = data<{ id: string }>(p2).id;
    // The default-home loop walks the reachable projects oldest first, so the order is pinned here.
    await prisma.project.update({ where: { id: p1Id }, data: { createdAt: new Date(1000) } });
    await prisma.project.update({ where: { id: p2Id }, data: { createdAt: new Date(2000) } });

    // Each project's anchor repo: a home project without one answers 409 threads.noFleetRepo (S5b-R13).
    const repo = (projectId: string, name: string) => prisma.fleetRepo.create({
      data: { projectId, provider: 'github', owner: 'acme', name, defaultBranch: 'trunk', createdById: ids.root },
    });
    p1RepoId = (await repo(p1Id, 'app-one')).id;
    await repo(p2Id, 'app-two');

    // `devBind`, `viewerBind` and `viewerCreator` each hold one PROJECT-scope binding in p1 and no
    // `ProjectMember` row: their only source in p1 is that binding (and the baseline member role).
    await createUser('devBind');
    await bind({ type: 'USER', id: ids.devBind }, 'developer', p1Id);
    await createUser('viewerBind');
    await bind({ type: 'USER', id: ids.viewerBind }, 'viewer', p1Id);
    await createUser('viewerCreator');
    await bind({ type: 'USER', id: ids.viewerCreator }, 'viewer', p1Id);

    // AC-3: an agent whose only source in p1 is a developer binding, so it holds no workspace key.
    ids.plainAgent = await createAgent('ws-plain-agent', [p1Id], [{ roleKey: 'developer', projectId: p1Id }]);

    // AC-4: the same agent shape plus one custom GLOBAL role holding the three workspace keys.
    await globalRole('workspace-agent', WORKSPACE_AGENT_KEYS);
    ids.hostAgent = await createAgent('ws-host-agent', [p1Id], [
      { roleKey: 'developer', projectId: p1Id },
      { roleKey: 'workspace-agent', projectId: null },
    ]);

    // AC-11: rostered in both projects, but a developer binding in p2 only — p1 hosts nothing for it.
    ids.homeAgent = await createAgent('ws-home-agent', [p1Id, p2Id], [
      { roleKey: 'developer', projectId: p2Id },
      { roleKey: 'workspace-agent', projectId: null },
    ]);

    await membership.invalidatePermissions();
  }, BOOT_TIMEOUT);

  afterAll(async () => { await app?.close(); });

  beforeEach(() => { resetThrottle(app); });

  const createBody = (homeProject?: string) => ({
    title: 'Workspace', backend: { kind: 'native', model: 'm1' }, ...(homeProject === undefined ? {} : { homeProject }),
  });

  // -------------------------------------------------------------------------
  // The sentinel: every principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: ids.root },
      { type: 'USER', id: ids.devBind },
      { type: 'USER', id: ids.viewerBind },
      { type: 'USER', id: ids.viewerCreator },
      { type: 'AGENT', id: ids.plainAgent },
      { type: 'AGENT', id: ids.hostAgent },
      { type: 'AGENT', id: ids.homeAgent },
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — hosting is the thread.create key of the named home project
  // -------------------------------------------------------------------------

  it('AC-1: a user whose only source in p1 is a developer binding creates a workspace thread there (201)', async () => {
    const res = await as('devBind', 'post', '/api/threads', createBody(P1_SLUG)).expect(201);

    const thread = data<ThreadBody>(res);
    expect(thread.homeProject.slug).toBe(P1_SLUG);
    expect(await reload(thread.id)).toEqual(expect.objectContaining({
      kind: 'WORKSPACE', projectId: p1Id, createdById: ids.devBind, createdByType: 'USER',
    }));
  }, TIMEOUT);

  it('AC-2: a user whose only source in p1 is a viewer binding is refused the create (403 permissions), and no thread is created', async () => {
    const before = await prisma.chatThread.count();

    expectPermissionsRefusal(await as('viewerBind', 'post', '/api/threads', createBody(P1_SLUG)));

    expect(await prisma.chatThread.count({ where: { createdById: ids.viewerBind } })).toBe(0);
    expect(await prisma.chatThread.count()).toBe(before);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 — agents on the workspace surface
  // -------------------------------------------------------------------------

  it('AC-3: an agent whose only source in p1 is a developer binding holds no workspace key (403 permissions)', async () => {
    expectPermissionsRefusal(await as('ws-plain-agent', 'post', '/api/threads', createBody()));
    expectPermissionsRefusal(await as('ws-plain-agent', 'post', '/api/threads', createBody(P1_SLUG)));

    expect(await prisma.chatThread.count({ where: { createdById: ids.plainAgent } })).toBe(0);
  }, TIMEOUT);

  it('AC-4: an agent granted the workspace keys by a GLOBAL role creates a workspace thread in p1 as an AGENT', async () => {
    const res = await as('ws-host-agent', 'post', '/api/threads', createBody(P1_SLUG)).expect(201);

    const thread = data<ThreadBody>(res);
    expect(thread).toEqual(expect.objectContaining({ createdByType: 'AGENT', homeProject: { slug: P1_SLUG, name: 'P1' } }));
    expect(await reload(thread.id)).toEqual(expect.objectContaining({
      kind: 'WORKSPACE', projectId: p1Id, createdById: ids.hostAgent, createdByType: 'AGENT',
    }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 — the creator reads its own thread through the key and the fence
  // -------------------------------------------------------------------------

  it('AC-5: the creator whose only source in p1 is a developer binding reads its thread and its messages (200)', async () => {
    const thread = await threadRow(ids.devBind);
    await prisma.chatMessage.create({ data: {
      threadId: thread.id, seq: 1, role: 'user', authorUserId: ids.devBind, content: 'hi', status: 'complete',
    } });

    const detail = await as('devBind', 'get', `/api/threads/${thread.id}`).expect(200);
    expect(data<ThreadBody>(detail).id).toBe(thread.id);

    const messages = await as('devBind', 'get', `/api/threads/${thread.id}/messages`).expect(200);
    expect(data<{ items: Array<{ content: string }> }>(messages).items.map((item) => item.content)).toEqual(['hi']);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 — stop is the thread.stop key of the home project
  // -------------------------------------------------------------------------

  it('AC-6: the creator whose only source in p1 is a developer binding stops its live turn, and a THREAD_STOP_TURN is created', async () => {
    const runnerRow = await runner();
    const thread = await threadRow(ids.devBind, { runnerId: runnerRow.id });
    const job = await liveJob(thread.id, runnerRow.id, ids.devBind);

    await as('devBind', 'post', `/api/threads/${thread.id}/stop`).expect(200);

    await expect(prisma.fleetCommand.findMany({ where: { jobId: job.id, type: 'THREAD_STOP_TURN' } })).resolves.toEqual([
      expect.objectContaining({ runnerId: runnerRow.id, leaseEpoch: 7, payload: {} }),
    ]);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-7 / AC-8 — the creator's keys are re-read from today's sources
  // -------------------------------------------------------------------------

  it('AC-7: a creator whose only source in p1 is now a viewer binding cannot change its cap (403 permissions), and the cap is unchanged', async () => {
    const thread = await threadRow(ids.viewerCreator, { maxCostUsd: '5' });

    expectPermissionsRefusal(await as('viewerCreator', 'patch', `/api/threads/${thread.id}`, { maxCostUsd: 3 }));

    expect((await reload(thread.id)).maxCostUsd.toString()).toBe('5');
  }, TIMEOUT);

  it('AC-8: a creator whose only source in p1 is now a viewer binding cannot message its thread (403 permissions), and no message is stored', async () => {
    const thread = await threadRow(ids.viewerCreator);

    expectPermissionsRefusal(await as('viewerCreator', 'post', `/api/threads/${thread.id}/messages`, {
      text: 'hello', clientMessageId: 'demoted-send',
    }));

    expect(await prisma.chatMessage.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.fleetJob.count({ where: { threadId: thread.id } })).toBe(0);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 — the workspace fence still answers 404, global admins included
  // -------------------------------------------------------------------------

  it('AC-9: a global admin gets 404 threads.notFound for another user\'s workspace thread', async () => {
    const thread = await threadRow(ids.devBind);

    expectNotFound(await as('root', 'get', `/api/threads/${thread.id}`));
    expectNotFound(await as('root', 'get', `/api/threads/${thread.id}/messages`));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 — an agent's default home comes from its roster and its keys
  // -------------------------------------------------------------------------

  it('AC-11: an agent granted the workspace keys, rostered in p1 and p2 with a developer binding in p2 only, homes a default thread in p2', async () => {
    const res = await as('ws-home-agent', 'post', '/api/threads', createBody()).expect(201);

    const thread = data<ThreadBody>(res);
    expect(thread.homeProject.slug).toBe(P2_SLUG);
    expect(await reload(thread.id)).toEqual(expect.objectContaining({
      kind: 'WORKSPACE', projectId: p2Id, createdById: ids.homeAgent, createdByType: 'AGENT',
    }));
  }, TIMEOUT);
});
