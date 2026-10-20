/**
 * Permissions P1 US-004 — every assistant and MCP tool checks its catalog key in the project it acts in, and an
 * approved action re-checks it (AC-2 .. AC-6, AC-9 .. AC-14, over real HTTP and real Postgres).
 *
 * Every tool call below enters a real route: the thread tools through
 * `POST /fleet/runner/jobs/:jobId/tools/:name?leaseEpoch=1` with the real key of the runner that holds the job, and
 * the MCP tools through `POST /api/mcp`. Each caller has exactly one kind of source in project `p1` — one
 * PROJECT-scope binding (users, no `ProjectMember` row anywhere), one binding plus its legacy `AgentProject` roster
 * row (agents), or a roster row with no role entry at all (AC-12) — so no refusal below is decided by a fixture.
 *
 * The thread jobs are RUNNING and their runner is offline (a `lastSeenAt` no placement window accepts), so a
 * dispatched job stays QUEUED for AC-6 and AC-14 to read.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/permissions-assistant-tools.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { enrollRunner } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const P2_SLUG = 'p2';
const P2_KEY = 'PTWO';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;
const ENV = ['FLEET_THREADS_ENABLED', 'MCP_ENABLED'] as const;
/** A `lastSeenAt` no placement window accepts, so a job dispatched in a test stays QUEUED. */
const OFFLINE_AT = new Date('2020-01-01T00:00:00.000Z');
const ACCEPT = 'application/json, text/event-stream';

/** `projects` declares no 40003 sentence, so the i18n lookup answers the key itself (as elsewhere in the suite). */
const PROJECTS_FORBIDDEN = 'projects.40003';

/** The runner tool route's answer: `{ content, isError }` data, whatever the status. */
interface ToolAnswer { content: string; isError: boolean }
/** An MCP `tools/call` result: the same two fields, with the content as the SDK's text parts. */
interface McpAnswer { isError: boolean; content: Array<{ type: string; text: string }> }

/** The three custom PROJECT roles this story needs; each one is the caller's only source in `p1`. */
const NO_COMMENT_ROLE = 'p1-thread-reader';
const UPDATER_ROLE = 'p1-ticket-updater';
const APPROVAL_READER_ROLE = 'p1-approval-reader';

describeIntegration('assistant tools check their key (US-004)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;

  let p1Id = '';
  let p2Id = '';
  let p1RepoId = '';
  let p1TicketId = '';
  let runnerId = '';
  let runnerKey = '';
  let seq = 0;

  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const agentKeys: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};

  const as = (who: string, method: 'get' | 'post', url: string, body?: Record<string, unknown>) => {
    const req = request(server)[method](url).set({ Authorization: `Bearer ${tokens[who]}` });
    return body === undefined ? req : req.send(body);
  };

  const createUser = async (who: string): Promise<void> => {
    resetThrottle(app);
    ids[who] = data<{ id: string }>(await as('root', 'post', '/api/admin/users', {
      email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER',
    }).expect(201)).id;
    resetThrottle(app);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
  };

  /** The binding that is the caller's only source in the project. */
  const bind = (principal: { type: 'USER' | 'AGENT'; id: string }, roleKey: string, projectId: string): Promise<unknown> =>
    membership.createBinding({ principal, roleKey, projectId }, { type: 'SYSTEM', id: 'test' });

  const createUserWithBinding = async (who: string, roleKey: string, projectId = p1Id): Promise<void> => {
    await createUser(who);
    await bind({ type: 'USER', id: ids[who] }, roleKey, projectId);
  };

  /**
   * An agent with no agent role of its own. `role` is the binding that is its only permission source in `p1`, and
   * `roster` also gives it the legacy `AgentProject` row (an agent whose only source is a binding needs none).
   */
  const createAgent = async (who: string, opts: { role?: string; roster?: boolean; projectId?: string } = {}): Promise<void> => {
    const created = await as('root', 'post', '/api/agents', { name: who, slug: who }).expect(201);
    const body = data<{ apiKey: string; agent: { id: string } }>(created);
    ids[who] = body.agent.id;
    agentKeys[who] = body.apiKey;
    if (opts.roster) await prisma.agentProject.create({ data: { agentId: body.agent.id, projectId: opts.projectId ?? p1Id } });
    if (opts.role) await bind({ type: 'AGENT', id: body.agent.id }, opts.role, opts.projectId ?? p1Id);
  };

  const customRole = (key: string, permissions: string[]) =>
    prisma.role.create({ data: { key, name: key, scope: 'PROJECT', system: false, permissions } });

  /**
   * A RUNNING THREAD job of `p1` whose requester is `requester` — the principal the executor runs the tool as. The
   * job is held by the suite's one runner at lease epoch 1, which is the fence the tool route proves.
   */
  const threadJob = async (requester: 'user' | 'agent', who: string): Promise<{ threadId: string; jobId: string }> => {
    const owner = { id: ids[who], type: requester === 'agent' ? 'AGENT' : 'USER' };
    const thread = await prisma.chatThread.create({ data: {
      kind: 'PROJECT', projectId: p1Id, title: `thread-${(seq += 1)}`, createdById: owner.id, createdByType: owner.type,
      runnerId: null, backend: { kind: 'native', model: 'm1' }, skills: [],
    } });
    const job = await prisma.fleetJob.create({ data: {
      projectId: p1Id, repoId: p1RepoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: owner.id,
      requestedByType: owner.type, state: 'RUNNING', runnerId, leaseEpoch: 1,
      firstStartedAt: new Date(), threadId: thread.id,
    } });
    await prisma.fleetThreadTurn.create({ data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go',
      backend: { kind: 'native', model: 'm1' }, skills: [], resume: false,
    } });
    return { threadId: thread.id, jobId: job.id };
  };

  /** One thread tool call: the runner's own key, the job's lease epoch, and the call's own id. */
  const callTool = (jobId: string, name: string, toolCallId: string, input: unknown) =>
    request(server)
      .post(`/api/fleet/runner/jobs/${jobId}/tools/${name}?leaseEpoch=1`)
      .set({ Authorization: `Bearer ${runnerKey}` })
      .send({ toolCallId, input });

  const answerOf = (res: request.Response): ToolAnswer => data<ToolAnswer>(res);

  /** One MCP `tools/call` by an agent's key; the JSON-RPC body is read from the SSE `data:` line. */
  const mcpCall = async (apiKey: string, name: string, args: Record<string, unknown>): Promise<McpAnswer> => {
    const res = await request(server).post('/api/mcp').set('Accept', ACCEPT)
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    const dataLine = res.text.split('\n').find((line) => line.startsWith('data:')) ?? '';
    const body = String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse(dataLine.slice(5))
      : res.body;
    return body.result as McpAnswer;
  };

  const textOf = (answer: McpAnswer): string => answer.content.map((part) => part.text).join('\n');

  beforeAll(async () => {
    for (const key of ENV) saved[key] = process.env[key];
    process.env['FLEET_THREADS_ENABLED'] = 'true';
    process.env['MCP_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client as PrismaClient;
    membership = app.get(MembershipService);

    const root = await request(server).post('/api/auth/register')
      .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    tokens.root = data<{ accessToken: string }>(root).accessToken;

    p1Id = data<{ id: string }>(await as('root', 'post', '/api/projects', { name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201)).id;
    p2Id = data<{ id: string }>(await as('root', 'post', '/api/projects', { name: 'P2', slug: P2_SLUG, key: P2_KEY }).expect(201)).id;
    // `koda_dispatch_job` resolves the repository by `owner/name` inside the project it acts in.
    p1RepoId = (await prisma.fleetRepo.create({ data: {
      projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: 'seed',
    } })).id;
    p1TicketId = (await prisma.ticket.create({ data: {
      projectId: p1Id, number: 1, type: 'BUG', status: 'CREATED', priority: 'MEDIUM',
      title: 'Fix login', description: 'the login form rejects valid credentials',
    } })).id;

    // The runner that holds every seeded THREAD job: enrolled (a real key), then put offline so a dispatch is placed
    // by nobody and the job AC-6 and AC-14 read is still QUEUED.
    const enrolled = await enrollRunner(server, tokens.root, 'assistant-permissions-runner');
    runnerId = enrolled.runnerId;
    runnerKey = enrolled.apiKey;
    await prisma.runner.update({
      where: { id: enrolled.runnerId },
      data: { protocolVersion: 4, enabled: true, lastSeenAt: OFFLINE_AT },
    });

    await customRole(NO_COMMENT_ROLE, ['thread.message.send.own', 'thread.read', 'ticket.read']);
    await customRole(UPDATER_ROLE, ['ticket.read', 'ticket.update', 'thread.read', 'thread.message.send.own']);
    await customRole(APPROVAL_READER_ROLE, ['thread.read', 'ticket.read', 'fleet.approval.read']);

    // AC-2, AC-4, AC-11: one PROJECT-scope binding each, and no `ProjectMember` row anywhere.
    await createUserWithBinding('viewerBind', 'viewer');
    await createUserWithBinding('devBind', 'developer');
    await createUserWithBinding('demoted', 'developer');
    // AC-3 and AC-13: the custom roles that leave exactly one key out.
    await createUserWithBinding('noComment', NO_COMMENT_ROLE);
    await createUserWithBinding('updater', UPDATER_ROLE);

    // AC-9: an agent whose only source in p1 is a viewer binding (and its roster row).
    await createAgent('p1-viewer-agent', { role: 'viewer', roster: true });
    // AC-10 and AC-14: an agent whose only source in p1 is a developer binding (and its roster row).
    await createAgent('p1-dev-agent', { role: 'developer', roster: true });
    // AC-5: a viewer binding in p1 and a developer binding in p2, so US-005 keeps listing the tool for it.
    await createAgent('p1-mcp-viewer-agent', { role: 'viewer', roster: true });
    await bind({ type: 'AGENT', id: ids['p1-mcp-viewer-agent'] }, 'developer', p2Id);
    // AC-6: a developer binding in p1, and nothing else.
    await createAgent('p1-mcp-dev-agent', { role: 'developer', roster: true });
    // AC-12: a roster row with no role entry and no binding at all.
    await createAgent('p1-roster-agent', { roster: true });

    // The rows were written after a principal could have been cached by an earlier check.
    await membership.invalidatePermissions();
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  // -------------------------------------------------------------------------
  // AC-2 — a read tool runs for a binding-only viewer
  // -------------------------------------------------------------------------

  it('AC-2: a viewer binding reads the project\'s tickets through koda_search_tickets', async () => {
    expect(await prisma.projectMember.count({ where: { userId: ids.viewerBind } })).toBe(0);
    const { jobId } = await threadJob('user', 'viewerBind');

    const answer = answerOf(await callTool(jobId, 'koda_search_tickets', 'ac2', {}).expect(200));

    expect(answer.isError).toBe(false);
    expect(answer.content).toContain(`${P1_KEY}-1`);
    expect(answer.content).toContain('Fix login');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-3 — the key is what refuses the write, not the membership
  // -------------------------------------------------------------------------

  it('AC-3: a custom role without comment.create is refused koda_add_comment and stores no action', async () => {
    const { jobId } = await threadJob('user', 'noComment');

    const answer = answerOf(await callTool(jobId, 'koda_add_comment', 'ac3', { ref: `${P1_KEY}-1`, body: 'hello' }).expect(200));

    expect(answer).toEqual({ content: 'forbidden: koda_add_comment needs comment.create on p1', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId, toolCallId: 'ac3' } })).toBe(0);
    expect(await prisma.comment.count({ where: { ticketId: p1TicketId } })).toBe(0);
    // The audit row is the proof the call reached the registered tool rather than being refused by name.
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId: 'ac3' } } }))
      .toMatchObject({ tool: 'koda_add_comment', outcome: 'forbidden', isError: true });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-4 — a developer binding still proposes
  // -------------------------------------------------------------------------

  it('AC-4: a developer binding is asked to approve koda_create_tickets', async () => {
    const { jobId } = await threadJob('user', 'devBind');

    const answer = answerOf(await callTool(jobId, 'koda_create_tickets', 'ac4', {
      tickets: [{ type: 'TASK', title: 'Write the runbook' }],
    }).expect(200));

    const action = await prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId: 'ac4' } } });
    expect(answer).toEqual({ content: `pending ${action.id}: awaiting user approval; do not retry`, isError: false });
    expect(action).toMatchObject({ status: 'PENDING', tool: 'koda_create_tickets', actorId: ids.devBind });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-5 / AC-6 — the MCP caller's key decides the dispatch
  // -------------------------------------------------------------------------

  it('AC-5: an MCP dispatch naming p1 is refused fleet.job.dispatch for a viewer binding, and creates no job', async () => {
    const feature = 'us004-ac5-dispatch';

    const answer = await mcpCall(agentKeys['p1-mcp-viewer-agent'], 'koda_dispatch_job', {
      project: P1_SLUG, repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5,
    });

    expect(textOf(answer)).toBe('forbidden: koda_dispatch_job needs fleet.job.dispatch on p1');
    expect(answer.isError).toBe(true);
    expect(await prisma.fleetJob.count({ where: { feature } })).toBe(0);
    expect(await prisma.pendingAction.count({ where: { actorId: ids['p1-mcp-viewer-agent'], tool: 'koda_dispatch_job' } })).toBe(0);
  }, TIMEOUT);

  it('AC-6: an MCP dispatch naming p1 by a developer binding creates a QUEUED job requested by the agent', async () => {
    const feature = 'us004-ac6-dispatch';

    const answer = await mcpCall(agentKeys['p1-mcp-dev-agent'], 'koda_dispatch_job', {
      project: P1_SLUG, repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5,
    });

    expect(answer.isError).toBe(false);
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { feature } });
    expect(job).toMatchObject({
      projectId: p1Id, requestedById: ids['p1-mcp-dev-agent'], requestedByType: 'AGENT', command: 'RUN', state: 'QUEUED',
    });
    expect(textOf(answer)).toContain(`dispatched ${job.id}`);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-9 — the runner tool route runs as the agent the job names
  // -------------------------------------------------------------------------

  it('AC-9: an agent viewer binding reads a ticket through the runner route, audited as that agent', async () => {
    const { jobId } = await threadJob('agent', 'p1-viewer-agent');

    const answer = answerOf(await callTool(jobId, 'koda_get_ticket', 'ac9', { ref: `${P1_KEY}-1` }).expect(200));

    expect(answer.isError).toBe(false);
    expect(answer.content).toContain(`${P1_KEY}-1`);
    expect(await prisma.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId: 'ac9' } } }))
      .toMatchObject({ actorType: 'agent', actorId: ids['p1-viewer-agent'], outcome: 'ok', isError: false });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-10 — an agent's thread write runs at once and is recorded against it
  // -------------------------------------------------------------------------

  it('AC-10: an agent developer binding adds a comment at once, recorded as a thread-origin agent action', async () => {
    const { jobId } = await threadJob('agent', 'p1-dev-agent');

    const answer = answerOf(await callTool(jobId, 'koda_add_comment', 'ac10', {
      ref: `${P1_KEY}-1`, body: 'the login form is fixed',
    }).expect(200));

    expect(answer.isError).toBe(false);
    expect(await prisma.comment.count({ where: { ticketId: p1TicketId, body: 'the login form is fixed', authorAgentId: ids['p1-dev-agent'] } }))
      .toBe(1);
    const action = await prisma.pendingAction.findFirstOrThrow({
      where: { actorType: 'agent', actorId: ids['p1-dev-agent'], tool: 'koda_add_comment', origin: 'thread' },
      orderBy: { createdAt: 'desc' },
    });
    // A direct action is stored with no job, toolCallId or thread (2a `insertDirect`), so it is found by its actor.
    expect(action).toMatchObject({
      status: 'EXECUTED', actorType: 'agent', actorId: ids['p1-dev-agent'], origin: 'thread', threadId: null,
    });
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-11 — the approve re-check reads the key, not the membership
  // -------------------------------------------------------------------------

  it('AC-11: the creator who lost comment.create is refused the approve with 403 projects and no comment is created', async () => {
    const { jobId } = await threadJob('user', 'demoted');
    const proposed = answerOf(await callTool(jobId, 'koda_add_comment', 'ac11', {
      ref: `${P1_KEY}-1`, body: 'approved too late',
    }).expect(200));
    expect(proposed.content.startsWith('pending ')).toBe(true);
    const action = await prisma.pendingAction.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId, toolCallId: 'ac11' } } });
    const commentsBefore = await prisma.comment.count({ where: { ticketId: p1TicketId } });

    // The creator's only source in p1 becomes a custom role with thread.read, ticket.read and fleet.approval.read.
    await prisma.roleBinding.deleteMany({ where: { principalType: 'USER', principalId: ids.demoted, projectId: p1Id } });
    await bind({ type: 'USER', id: ids.demoted }, APPROVAL_READER_ROLE, p1Id);
    await membership.invalidatePermissions();

    const res = await request(server).post(`/api/projects/${P1_SLUG}/fleet/approvals/${action.approvalId}/decide`)
      .set({ Authorization: `Bearer ${tokens.demoted}` })
      .send({ decision: 'approve' })
      .expect(403);

    expect(res.body.ret).toBe(40003);
    expect(res.body.message).toBe(PROJECTS_FORBIDDEN);
    expect(await prisma.comment.count({ where: { ticketId: p1TicketId } })).toBe(commentsBefore);
    expect((await prisma.pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('PENDING');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-12 — an implicit key passes for a caller that holds nothing
  // -------------------------------------------------------------------------

  it('AC-12: koda_get_action for an unknown id answers not_found for a roster-only agent, never a refusal', async () => {
    const answer = await mcpCall(agentKeys['p1-roster-agent'], 'koda_get_action', { project: P1_SLUG, id: 'no-such-action' });

    expect(textOf(answer)).toBe('not_found');
    expect(answer.isError).toBe(true);
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-13 — the start move needs its own key, checked in the preview
  // -------------------------------------------------------------------------

  it('AC-13: a custom role with ticket.update but no ticket.transition.start is refused the start and stores no action', async () => {
    const { jobId } = await threadJob('user', 'updater');

    const answer = answerOf(await callTool(jobId, 'koda_update_ticket', 'ac13', {
      ref: `${P1_KEY}-1`, status: 'IN_PROGRESS',
    }).expect(200));

    expect(answer).toEqual({ content: 'forbidden: koda_update_ticket needs ticket.transition.start on p1', isError: true });
    expect(await prisma.pendingAction.count({ where: { jobId, toolCallId: 'ac13' } })).toBe(0);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: p1TicketId } })).status).toBe('CREATED');
  }, TIMEOUT);

  // -------------------------------------------------------------------------
  // AC-14 — the dispatch a thread agent runs is attributed to the agent
  // -------------------------------------------------------------------------

  it('AC-14: a thread dispatch from an agent developer binding creates a QUEUED job requested by that agent', async () => {
    const { jobId } = await threadJob('agent', 'p1-dev-agent');
    const feature = 'us004-ac14-dispatch';

    const answer = answerOf(await callTool(jobId, 'koda_dispatch_job', 'ac14', {
      repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5,
    }).expect(200));

    expect(answer.isError).toBe(false);
    const job = await prisma.fleetJob.findFirstOrThrow({ where: { feature } });
    expect(job).toMatchObject({
      projectId: p1Id, requestedById: ids['p1-dev-agent'], requestedByType: 'AGENT', state: 'QUEUED',
    });
  }, TIMEOUT);
});
