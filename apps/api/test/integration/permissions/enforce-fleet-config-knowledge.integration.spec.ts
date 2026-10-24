/**
 * Permissions P1d US-007 — the repo config–edit, nax-files, drift-check and fleet knowledge routes
 * decide with catalog keys, over real HTTP + Postgres (AC-1 .. AC-14).
 *
 * One booted application for the whole file. The first registration is the installation's Owner, so
 * the fixtures (users, project, repo, knowledge patterns, agent bindings) are built as that Owner;
 * every assertion below acts as a principal whose only source in `p1` is one role binding (users) or
 * a `viewer` binding with (or without) a role binding (agents). No test asserts through a bypass.
 *
 * The forge is not part of what this story decides: the `FLEET_REPO_FILES_READER` the app resolved is
 * spied on, so the handler's own repo-ownership lookup and validation still run, and only the HTTP
 * call to the forge is answered locally. The knowledge index queue is stubbed for the same reason —
 * these cases pin the route's decision, not the pass (knowledge-repo-indexer.spec.ts covers it).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/permissions/enforce-fleet-config-knowledge.integration.spec.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FLEET_CFG, IFleetConfig } from '../../../src/config/fleet.config';
import { KnowledgeIndexQueue } from '../../../src/fleet/knowledge/knowledge-index.queue';
import { FLEET_REPO_FILES_READER, type FleetRepoFilesReader } from '../../../src/fleet/repo-config/fleet-repo-files.reader';
import { MembershipService } from '../../../src/permissions/membership.service';
import { expectBindingOnlyFixtures, grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
const P1_KEY = 'PONE';
const TIMEOUT = 30_000;
const BOOT_TIMEOUT = 60_000;
const HEAD = 'c'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

const readI18n = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../../../src/i18n/en/${file}.json`), 'utf8')) as Record<string, string>;

/** The role key an agent's legacy `AgentRoleEntry` role is read as (the union's own mapping). */
const ROLE_KEY_FOR_AGENT_ROLE: Record<'DEVELOPER' | 'REVIEWER' | 'VERIFIER' | 'TRIAGER', string> = {
  DEVELOPER: 'developer',
  REVIEWER: 'reviewer',
  VERIFIER: 'verifier',
  TRIAGER: 'triager',
};

/** `permissions.40003`, the sentence every refused key carries. */
const PERMISSIONS_REFUSED = readI18n('permissions')['40003'];

/** A valid edit set: one allowlisted `.nax` path, its base blob and the commit the editor read. */
const VALID_EDIT = {
  baseSha: HEAD,
  prTitle: 'Tighten testing rule',
  prBody: null,
  edits: [{ path: '.nax/rules/testing.md', op: 'put', content: '# Testing\n', baseSha: BASE_SHA }],
};

describeIntegration('repo config and fleet knowledge route keys (US-007)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let membership: MembershipService;
  let reader: { list: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };
  let enqueueSpy: ReturnType<typeof vi.spyOn> | undefined;
  let enabledBefore: boolean | undefined;

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  let p1Id = '';
  let repoId = '';
  let counter = 0;
  let rootId = '';
  let developerAgentId = '';
  const agentIds: string[] = [];

  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  /** The fleet config the booted app's controllers read, so a case can turn indexing on and put it back. */
  const fleetConfig = (): IFleetConfig => app.get<IFleetConfig>(FLEET_CFG, { strict: false });
  const asRoot = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set(auth('root'));
    return body === undefined ? req : req.send(body);
  };
  const getAs = (who: string, url: string) => request(server).get(url).set(auth(who));
  const postAs = (who: string, url: string, body?: Record<string, unknown>) => {
    const req = request(server).post(url).set(auth(who));
    return body === undefined ? req : req.send(body);
  };

  /** The refusal contract of one refused permission key: 403, code 40003, the exact sentence. */
  const expectPermissionsRefusal = (res: request.Response): void => {
    expect(res.status).toBe(403);
    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PERMISSIONS_REFUSED);
  };

  const createUser = async (who: string): Promise<void> => {
    const created = await asRoot('post', '/api/admin/users', {
      email: `${who}@koda.test`,
      name: who,
      password: TEST_PASSWORD,
      role: 'MEMBER',
    }).expect(201);
    userIds[who] = data<{ id: string }>(created).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in p1. */
  const bind = (who: string, roleKey: string): Promise<unknown> =>
    withTestActor({ type: 'SYSTEM', id: 'seed' }, () => membership.createBinding(
      { principal: { type: 'USER', id: userIds[who] }, roleKey, projectId: p1Id },
      { type: 'SYSTEM', id: 'test' },
    ));

  /** A rostered agent whose only key source is the `viewer` binding plus the role binding given. */
  const createAgent = async (slug: string, agentRole?: 'DEVELOPER'): Promise<string> => {
    const created = await asRoot('post', '/api/agents', { name: slug, slug }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    const agent = { type: 'AGENT' as const, id: body.agent.id };
    await grantBaseline(db, agent);
    await grantRole(db, agent, 'viewer', p1Id);
    if (agentRole) await grantRole(db, agent, ROLE_KEY_FOR_AGENT_ROLE[agentRole], p1Id);
    tokens[slug] = body.apiKey;
    // The bindings are written after the principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
    return body.agent.id;
  };

  const repoBase = () => `/api/projects/${P1_SLUG}/fleet/repos/${repoId}`;
  const jobConfigEditUrl = (id: string) => `/api/projects/${P1_SLUG}/fleet/jobs/${id}/config-edit`;
  const knowledgeBase = () => `/api/projects/${P1_SLUG}/knowledge`;
  const reindexUrl = (repo: string) => `${knowledgeBase()}/repos/${repo}/reindex`;

  /** Config jobs serialize per repo, so a test that queues one cancels it before the next runs. */
  const cancelActiveConfigJobs = () =>
    db.fleetJob.updateMany({
      where: { repoId, feature: 'nax-config', state: { in: ['QUEUED', 'ASSIGNED', 'RUNNING'] } },
      data: { state: 'CANCELLED' },
    });

  const configJobCount = () => db.fleetJob.count({ where: { projectId: p1Id, command: { in: ['CONFIG_EDIT', 'CONFIG_DRIFT'] } } });

  /** A finished config job of p1 with its stored edit set, as "Reopen edits" reads it. */
  const storedConfigJob = async (over: Partial<Prisma.FleetJobUncheckedCreateInput> = {}): Promise<{ id: string }> => {
    const job = await db.fleetJob.create({
      data: {
        projectId: p1Id, repoId, ref: 'trunk', command: 'CONFIG_EDIT', feature: `config-fixture-${(counter += 1)}`, profiles: [],
        maxCostUsd: new Prisma.Decimal(0), selectorLabels: [], requestedById: userIds.other, state: 'COMPLETED',
        finishedAt: new Date(), ...over,
      },
      select: { id: true },
    });
    await db.fleetConfigEdit.create({
      data: { jobId: job.id, mode: 'edit', edits: VALID_EDIT.edits, prTitle: VALID_EDIT.prTitle, prBody: null, baseSha: HEAD },
    });
    return job;
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    membership = app.get(MembershipService);

    // The forge is not what these cases decide, so the app's own reader answers locally.
    reader = app.get<FleetRepoFilesReader>(FLEET_REPO_FILES_READER) as unknown as typeof reader;
    vi.spyOn(reader, 'list').mockImplementation(async (repo: { defaultBranch: string }) => ({
      baseSha: HEAD,
      defaultBranch: repo.defaultBranch,
      files: [{ path: '.nax/context.md', size: 9, blobSha: 'k'.repeat(40), group: 'context' }],
    }));
    vi.spyOn(reader, 'read').mockImplementation(async (_repo: unknown, path: string) => ({
      path,
      blobSha: 'k'.repeat(40),
      content: '# Context',
    }));

    // The index pass itself is not what these cases decide; the save/reindex decisions are.
    enqueueSpy = vi.spyOn(app.get(KnowledgeIndexQueue), 'enqueue').mockImplementation(() => undefined);

    enabledBefore = fleetConfig().knowledgeIndexEnabled;
    fleetConfig().knowledgeIndexEnabled = true;

    const root = await request(server)
      .post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD })
      .expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;

    for (const who of ['viewer', 'developer', 'padmin', 'other', 'outsider', 'custom']) await createUser(who);

    const project = await asRoot('post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201);
    p1Id = data<{ id: string }>(project).id;
    repoId = (
      await db.fleetRepo.create({
        data: { projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: rootId },
      })
    ).id;

    await bind('viewer', 'viewer');
    await bind('developer', 'developer');
    await bind('padmin', 'project-admin');
    // AC-14: a custom role that holds only project access and `ticket.read`, so every knowledge key is
    // refused. US-001: `project.read` is what lets the caller reach the project at all.
    await db.role.create({
      data: {
        key: 'ticket-reader',
        name: 'Ticket Reader',
        scope: 'PROJECT',
        permissions: ['project.read', 'ticket.read'],
      },
    });
    await bind('custom', 'ticket-reader');

    developerAgentId = await createAgent('p1-developer-agent', 'DEVELOPER');
    agentIds.push(developerAgentId);
    agentIds.push(await createAgent('p1-roster-agent'));
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    enqueueSpy?.mockRestore();
    vi.restoreAllMocks();
    if (enabledBefore !== undefined) fleetConfig().knowledgeIndexEnabled = enabledBefore;
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // The sentinel: every fixture principal of this file is granted through bindings only
  // -------------------------------------------------------------------------

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(db, [
      { type: 'USER', id: rootId },
      { type: 'USER', id: userIds.viewer },
      { type: 'USER', id: userIds.developer },
      { type: 'USER', id: userIds.padmin },
      { type: 'USER', id: userIds.other },
      { type: 'USER', id: userIds.outsider },
      { type: 'USER', id: userIds.custom },
      ...agentIds.map((id) => ({ type: 'AGENT' as const, id })),
    ]);
  });

  // -------------------------------------------------------------------------
  // AC-1 / AC-2 — the two reads a viewer and a rostered agent hold
  // -------------------------------------------------------------------------

  it('AC-1: a viewer binding alone lists the allowlisted .nax files (200)', async () => {
    const res = await getAs('viewer', `${repoBase()}/nax-files`).expect(200);

    expect(data<{ baseSha: string; files: Array<{ path: string }> }>(res).files.map((file) => file.path)).toEqual([
      '.nax/context.md',
    ]);
  }, TIMEOUT);

  it('AC-2: a roster-only agent reads a config job of the project (200)', async () => {
    const job = await storedConfigJob();

    const res = await getAs('p1-roster-agent', jobConfigEditUrl(job.id)).expect(200);

    expect(data<{ mode: string; baseSha: string }>(res)).toEqual(expect.objectContaining({ mode: 'edit', baseSha: HEAD }));
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 / AC-4 / AC-5 — a viewer's writes are refused with the permissions code
  // -------------------------------------------------------------------------

  it('AC-3: a viewer binding alone is refused by POST config-edits with the permissions code', async () => {
    const res = await postAs('viewer', `${repoBase()}/config-edits`, VALID_EDIT);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-4: the refused viewer config edit creates no job', async () => {
    const before = await configJobCount();

    await postAs('viewer', `${repoBase()}/config-edits`, VALID_EDIT).expect(403);

    expect(await configJobCount()).toBe(before);
  }, TIMEOUT);

  it('AC-5: a viewer binding alone is refused by POST drift-checks with the permissions code', async () => {
    const res = await postAs('viewer', `${repoBase()}/drift-checks`);

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-6 / AC-7 / AC-8 — drift checks need fleet.repo.drift.check, and an agent's job is its own
  // -------------------------------------------------------------------------

  it('AC-6: a developer binding alone queues a drift check (201)', async () => {
    await cancelActiveConfigJobs();

    const res = await postAs('developer', `${repoBase()}/drift-checks`).expect(201);

    expect(data<{ job: { command: string; state: string } }>(res).job).toEqual(
      expect.objectContaining({ command: 'CONFIG_DRIFT', state: 'QUEUED' }),
    );
  }, TIMEOUT);

  it('AC-7: a DEVELOPER agent queues a drift check (201)', async () => {
    await cancelActiveConfigJobs();

    const res = await postAs('p1-developer-agent', `${repoBase()}/drift-checks`).expect(201);

    expect(data<{ job: { command: string } }>(res).job.command).toBe('CONFIG_DRIFT');
  }, TIMEOUT);

  it("AC-8: that agent's drift check records the job as requested by the agent", async () => {
    await cancelActiveConfigJobs();

    const created = data<{ job: { id: string } }>(await postAs('p1-developer-agent', `${repoBase()}/drift-checks`).expect(201)).job;

    await expect(db.fleetJob.findUniqueOrThrow({ where: { id: created.id } })).resolves.toEqual(
      expect.objectContaining({ requestedById: developerAgentId, requestedByType: 'AGENT' }),
    );
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 / AC-10 / AC-11 / AC-12 — the knowledge routes
  // -------------------------------------------------------------------------

  it('AC-9: a developer binding alone queues a reindex pass (202) while indexing is enabled', async () => {
    enqueueSpy?.mockClear();

    const res = await postAs('developer', reindexUrl(repoId)).expect(202);

    expect(data<{ queued: boolean }>(res)).toEqual({ queued: true });
    expect(enqueueSpy).toHaveBeenCalledWith(repoId, 'admin');
  }, TIMEOUT);

  it('AC-10: a developer binding alone is refused by PUT patterns with the permissions code', async () => {
    const res = await request(server)
      .put(`${knowledgeBase()}/patterns`)
      .set(auth('developer'))
      .send({ patterns: ['handbook/*.md'] });

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  it('AC-11: a project-admin binding saves the corpus patterns (200)', async () => {
    const res = await request(server)
      .put(`${knowledgeBase()}/patterns`)
      .set(auth('padmin'))
      .send({ patterns: ['handbook/*.md'] })
      .expect(200);

    expect(data<{ patterns: string[]; custom: boolean }>(res)).toEqual(
      expect.objectContaining({ patterns: ['handbook/*.md'], custom: true }),
    );
    await expect(db.knowledgeProjectPatterns.findUniqueOrThrow({ where: { projectId: p1Id } })).resolves.toEqual(
      expect.objectContaining({ patterns: ['handbook/*.md'] }),
    );
  }, TIMEOUT);

  it('AC-12: a viewer binding alone is refused by the reindex with the permissions code', async () => {
    const res = await postAs('viewer', reindexUrl(repoId));

    expectPermissionsRefusal(res);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 / AC-14 — a rostered agent reads the index state; a ticket-only role reads nothing
  // -------------------------------------------------------------------------

  it('AC-13: a roster-only agent lists the knowledge repositories (200)', async () => {
    const res = await getAs('p1-roster-agent', `${knowledgeBase()}/repos`).expect(200);

    expect(data<{ repos: Array<{ repoId: string }> }>(res).repos.map((repo) => repo.repoId)).toEqual([repoId]);
  }, TIMEOUT);

  it('AC-14: a ticket.read-only custom role is refused by the knowledge search with the permissions code', async () => {
    const res = await postAs('custom', `${knowledgeBase()}/search`, { query: 'x' });

    expectPermissionsRefusal(res);
  }, TIMEOUT);
});
