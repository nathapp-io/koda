import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import type { ToolCaller } from '../../../src/fleet/assistant/assistant-tool.types';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('direct assistant actions (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let executor: AssistantToolExecutor;
  let world: FleetHttpWorld;
  let number = 100;
  const saved = process.env.FLEET_THREADS_ENABLED;
  beforeAll(async () => {
    process.env.FLEET_THREADS_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
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
    return { principal: { actorType: 'agent', id: agent.id, slug: agent.slug, name: 'claude', status: 'ACTIVE', agentRoles: ['DEVELOPER'], capabilities: [], authorities: [], blacklisted: false, revoked: false }, origin: { kind: 'mcp' }, disabled: false };
  }
  async function seedTicket(projectId = world.projectId) {
    return prisma.ticket.create({ data: { projectId, number: ++number, type: 'TASK', title: 'Direct action ticket' } });
  }

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('fixtures grant through bindings only', async () => {
    await expectBindingOnlyFixtures(prisma, [
      { type: 'USER', id: world.ids.root },
      { type: 'USER', id: world.ids.dev },
      { type: 'USER', id: world.ids.viewer },
      { type: 'USER', id: world.ids.outsider },
    ]);
  });
  it('creates an agent-authored comment without an approval request or action suffix', async () => {
    const caller = await seedCaller();
    const ticket = await seedTicket();
    const result = await executor.executeFor(caller, { name: 'koda_add_comment', input: { project: 'web', ref: `WEB-${ticket.number}`, body: 'from mcp' } });
    expect(result.isError).toBe(false);
    const comments = await prisma.comment.findMany({ where: { ticketId: ticket.id }, take: 10 });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorAgentId: caller.principal.id, authorUserId: null, body: 'from mcp' });
    expect(await prisma.approvalRequest.count({ where: { actorId: caller.principal.id } })).toBe(0);
    expect(result.content).not.toContain('\naction ');
  });
  it('AC-14: hides the unrostered project without a comment or action', async () => {
    const caller = await seedCaller();
    const ticket = await seedTicket(world.opsProjectId);
    expect(await executor.executeFor(caller, { name: 'koda_add_comment', input: { project: 'ops', ref: `OPS-${ticket.number}`, body: 'from mcp' } })).toEqual({ content: 'not_found: project', isError: true });
    expect(await prisma.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await prisma.approvalRequest.count({ where: { projectId: world.opsProjectId, actorId: caller.principal.id } })).toBe(0);
  });
  it('AC-15: another rostered agent cannot read the caller action', async () => {
    const caller = await seedCaller();
    const other = await seedCaller();
    const ticket = await seedTicket();
    await prisma.approvalPolicy.create({ data: { selector: `${world.projectId}|comment.create|type:AGENT`, projectId: world.projectId, permissionPattern: 'comment.create', principalType: 'AGENT', mode: 'agent', updatedByType: 'SYSTEM', updatedById: 'test' } });
    await executor.executeFor(caller, { name: 'koda_add_comment', input: { project: 'web', ref: `WEB-${ticket.number}`, body: 'from mcp' } });
    const action = await prisma.approvalRequest.findFirstOrThrow({ where: { actorId: caller.principal.id } });
    const input = { project: 'web', id: action.id };
    expect((await executor.executeFor(caller, { name: 'koda_get_action', input })).content).toContain(`action ${action.id}`);
    expect(await executor.executeFor(other, { name: 'koda_get_action', input })).toEqual({ content: 'not_found', isError: true });
  });
});
