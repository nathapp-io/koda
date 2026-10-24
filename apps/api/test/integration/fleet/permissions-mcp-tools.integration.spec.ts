import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P1 US-005 — `POST /api/mcp` lists only the tools whose key the agent holds somewhere (AC-1 .. AC-4,
 * AC-6, over real HTTP and real Postgres).
 *
 * Every agent below is created through `POST /api/agents` (a real key, authenticated by the real guard chain) and
 * has exactly one kind of source in `p1`: one PROJECT-scope `viewer` binding, one `developer` binding, nothing at
 * all, or a GLOBAL `admin` binding. The listing is per key, not per project (US-005 scope): a tool is offered when
 * the agent holds its key in at least one project, and the executor still refuses a call that names a project where
 * the key is missing.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      bun run test:scoped test/integration/fleet/permissions-mcp-tools.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { mcpToolDescriptors } from '../../../src/fleet/assistant/mcp/mcp-tool-catalog';
import { MembershipService } from '../../../src/permissions/membership.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const P1_SLUG = 'p1';
/** `CreateProjectDto.key` is `^[A-Z]{2,6}$` — letters only. */
const P1_KEY = 'PONE';
const BOOT_TIMEOUT = 120_000;
const TIMEOUT = 30_000;
const ACCEPT = 'application/json, text/event-stream';
/** The MCP catalog as a client sees it: the workspace projection, `koda_my_projects` first. */
const DESCRIPTOR_NAMES = mcpToolDescriptors().map((descriptor) => descriptor.name);

/** One JSON-RPC answer: a result, an error, or (never here) neither. */
interface RpcAnswer {
  result?: { tools?: Array<{ name: string }> } & Record<string, unknown>;
  error?: { code: number; message: string };
}

describeIntegration('MCP tools/list lists only the tools whose key the agent holds (US-005)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let membership: MembershipService;

  let p1Id = '';
  let rootToken = '';
  const agentKeys: Record<string, string> = {};
  const agentIds: Record<string, string> = {};
  const saved: Record<string, string | undefined> = {};

  const asRoot = (): { Authorization: string } => ({ Authorization: `Bearer ${rootToken}` });

  /** One JSON-RPC request by an agent's own key; a 2025-era client is answered as one SSE event. */
  const rpc = async (apiKey: string, method: string, params: Record<string, unknown> = {}): Promise<RpcAnswer> => {
    const res = await request(server).post('/api/mcp').set('Accept', ACCEPT)
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ jsonrpc: '2.0', id: 1, method, params })
      .expect(200);
    const dataLine = res.text.split('\n').find((line) => line.startsWith('data:')) ?? '';
    return String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse(dataLine.slice(5))
      : (res.body as RpcAnswer);
  };

  const listedTools = async (who: string): Promise<string[]> => {
    const answer = await rpc(agentKeys[who] as string, 'tools/list');
    return (answer.result?.tools ?? []).map((tool) => tool.name);
  };

  /**
   * An agent with no agent role of its own; `role` is bound in `p1` and `globalRole` at the global scope, so the
   * binding is the only permission source the listing can read.
   */
  const createAgent = async (who: string, opts: { role?: string; globalRole?: string } = {}): Promise<void> => {
    resetThrottle(app);
    const created = data<{ apiKey: string; agent: { id: string } }>(
      await request(server).post('/api/agents').set(asRoot()).send({ name: who, slug: who }).expect(201),
    );
    agentIds[who] = created.agent.id;
    agentKeys[who] = created.apiKey;
    if (opts.role) {
      await withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
        membership.createBinding({ principal: { type: 'AGENT', id: created.agent.id }, roleKey: opts.role, projectId: p1Id }, { type: 'SYSTEM', id: 'test' }));
    }
    if (opts.globalRole) {
      await withTestActor({ type: 'SYSTEM', id: 'seed' }, () =>
        membership.createBinding({ principal: { type: 'AGENT', id: created.agent.id }, roleKey: opts.globalRole, projectId: null }, { type: 'SYSTEM', id: 'test' }));
    }
  };

  beforeAll(async () => {
    for (const key of ['MCP_ENABLED', 'REGISTRATION_ENABLED'] as const) saved[key] = process.env[key];
    process.env['MCP_ENABLED'] = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    membership = app.get(MembershipService);

    rootToken = data<{ accessToken: string }>(
      await request(server).post('/api/auth/register')
        .send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
    ).accessToken;

    p1Id = data<{ id: string }>(
      await request(server).post('/api/projects').set(asRoot()).send({ name: 'P1', slug: P1_SLUG, key: P1_KEY }).expect(201),
    ).id;
    // AC-4: the repository a real dispatch would need, so the only reason no job is created is the unknown tool.
    await prisma.fleetRepo.create({ data: {
      projectId: p1Id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', createdById: 'seed',
    } });

    // AC-1 and AC-4: a viewer binding in p1 and nothing else.
    await createAgent('viewer-agent', { role: 'viewer' });
    // AC-2: a developer binding in p1 and nothing else.
    await createAgent('developer-agent', { role: 'developer' });
    // AC-3: nothing at all — the global `agent` baseline binding goes too, so no binding and no global role is left.
    await createAgent('bare-agent');
    await prisma.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: agentIds['bare-agent'] } });
    // AC-6: a GLOBAL admin binding.
    await createAgent('admin-agent', { globalRole: 'admin' });

    await membership.invalidatePermissions();
  }, BOOT_TIMEOUT);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1: a viewer binding lists the read tools it holds and not the writes it does not', async () => {
    // The agent's only project-scope source: a `viewer` binding in p1. (Its global `agent` baseline binding grants
    // `agent.read` and no project key, and it has no roster row, so nothing else answers a project key.)
    expect(await prisma.roleBinding.findMany({
      where: { principalType: 'AGENT', principalId: agentIds['viewer-agent'], projectId: { not: null } },
      select: { projectId: true, role: { select: { key: true } } },
    })).toEqual([{ projectId: p1Id, role: { key: 'viewer' } }]);

    const listed = await listedTools('viewer-agent');

    expect(listed).toContain('koda_search_tickets');
    expect(listed).toContain('koda_list_jobs');
    expect(listed).not.toContain('koda_dispatch_job');
    expect(listed).not.toContain('koda_create_tickets');
    expect(listed).not.toContain('koda_add_memory');
    // The visibility is the key's, not a read-only heuristic: `viewer` holds `comment.create` too.
    expect(listed).toContain('koda_add_comment');
    // Catalog order is preserved by the filter, so the listing stays a subsequence of the catalog.
    expect(listed).toEqual(DESCRIPTOR_NAMES.filter((name) => listed.includes(name)));
  }, TIMEOUT);

  it('AC-2: a developer binding lists the dispatch, ticket-create and memory tools', async () => {
    const listed = await listedTools('developer-agent');

    expect(listed).toContain('koda_dispatch_job');
    expect(listed).toContain('koda_create_tickets');
    expect(listed).toContain('koda_add_memory');
    // Catalog order survives the filter: the listing is a subsequence of it.
    expect(listed).toEqual(DESCRIPTOR_NAMES.filter((name) => listed.includes(name)));
  }, TIMEOUT);

  it('AC-3: an agent with no binding, no roster row and no global role lists exactly the workspace and implicit-key tools', async () => {
    expect(await prisma.roleBinding.count({ where: { principalType: 'AGENT', principalId: agentIds['bare-agent'] } })).toBe(0);

    const listed = await listedTools('bare-agent');

    expect(listed).toEqual(['koda_my_projects', 'koda_get_action']);
  }, TIMEOUT);

  it('AC-4: a dispatch call by a viewer-only agent answers the SDK unknown-tool error and creates no job', async () => {
    const feature = 'us005-unknown-tool';

    const answer = await rpc(agentKeys['viewer-agent'] as string, 'tools/call', {
      name: 'koda_dispatch_job',
      arguments: { project: P1_SLUG, repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5 },
    });

    expect(answer.error).toEqual({ code: -32602, message: 'Tool koda_dispatch_job not found' });
    expect(await prisma.fleetJob.count({ where: { feature } })).toBe(0);
    // The tool never ran, so neither a tool-call audit row nor an action names it.
    expect(await prisma.assistantToolCall.count({ where: { actorId: agentIds['viewer-agent'], tool: 'koda_dispatch_job' } })).toBe(0);
    expect(await prisma.pendingAction.count({ where: { actorId: agentIds['viewer-agent'], tool: 'koda_dispatch_job' } })).toBe(0);
  }, TIMEOUT);

  it('AC-6: a global admin binding lists every MCP descriptor name', async () => {
    const listed = await listedTools('admin-agent');

    expect(listed).toEqual(DESCRIPTOR_NAMES);
  }, TIMEOUT);
});
