import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AGENT_ROLES } from '../../../src/common/enums';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import type { ToolCaller } from '../../../src/fleet/assistant/assistant-tool.types';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
describeIntegration('MCP caller project isolation (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let executor: AssistantToolExecutor;
  let world: FleetHttpWorld;
  const saved = process.env.FLEET_THREADS_ENABLED;
  beforeAll(async () => {
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    executor = app.get(AssistantToolExecutor, { strict: false });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.FLEET_THREADS_ENABLED;
    else process.env.FLEET_THREADS_ENABLED = saved;
  });
  async function seedCaller(): Promise<ToolCaller> {
    const agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(prisma, agent.id, world.projectId);
    return { principal: { actorType: 'agent', id: agent.id, slug: agent.slug, name: 'claude', status: 'ACTIVE', agentRoles: [...AGENT_ROLES], capabilities: [], authorities: [], blacklisted: false, revoked: false }, origin: { kind: 'mcp' }, disabled: false };
  }
  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });
  it('AC-13, AC-15: rostered project search returns its ticket and audits the agent with no job', async () => {
    const caller = await seedCaller();
    await prisma.ticket.create({ data: { projectId: world.projectId, number: 1, type: 'TASK', title: 'MCP caller ticket' } });
    const result = await executor.executeFor(caller, { name: 'koda_search_tickets', input: { project: 'web', query: 'MCP caller ticket' } });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('WEB-1');
    expect(result.content).toContain('MCP caller ticket');
    const rows = await prisma.assistantToolCall.findMany({ where: { actorId: caller.principal.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'agent', actorId: caller.principal.id, jobId: null, threadId: null, toolCallId: null, projectId: world.projectId });
  });
  it('AC-14: another project is not found even if its ticket exists', async () => {
    const caller = await seedCaller();
    await prisma.ticket.create({ data: { projectId: world.opsProjectId, number: 1, type: 'TASK', title: 'Foreign ticket' } });
    expect(await executor.executeFor(caller, { name: 'koda_search_tickets', input: { project: 'ops', query: 'Foreign ticket' } })).toEqual({ content: 'not_found: project', isError: true });
  });
});
