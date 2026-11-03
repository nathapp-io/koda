import { canRunDbTests } from '../../helpers/test-environment';
/**
 * memory-notes US-002 — one memory item read by id against PG, and the same read over the MCP registrations.
 *
 * Acceptance setup: the `web` world of `seedFleetHttpWorld` (project `web`, project `ops`, four users), one NOTE of
 * `web` with a Markdown body, one soft-deleted NOTE of `web`, one NOTE of `ops`, and an agent rostered in `web`
 * through role bindings, so it holds `memory.read` there and nothing in `ops`.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/assistant-get-memory-tool.integration.spec.ts
 */
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AGENT_ROLES } from '../../../src/common/enums';
import type { AgentPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';
import { kodaMcpToolRegistrations, visibleMcpToolNames } from '../../../src/fleet/assistant/mcp/mcp-server.factory';
import { mcpToolDescriptors } from '../../../src/fleet/assistant/mcp/mcp-tool-catalog';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });

/** The body of the note the ACs read: long enough to be unmistakable in the tool text. */
const NOTE_BODY = 'Budget stays 2,048 MiB: raise it only with a queue-depth incident.';

describeIntegration('fleet assistant get-memory tool (PG, memory-notes US-002)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let governance: MemoryGovernanceService;
  let executor: AssistantToolExecutor;
  let registry: AssistantToolRegistry;
  let permissions: PermissionService;
  let note: { id: string };
  let deletedNote: { id: string };
  let foreignNote: { id: string };

  /** One NOTE of `projectId`, with the fields the read is judged on spelled out. */
  const noteIn = (projectId: string, slug: string, over: { deletedAt?: Date } = {}) =>
    prisma.memoryItem.create({
      data: {
        projectId,
        kind: 'NOTE',
        subject: slug,
        predicate: 'project',
        object: NOTE_BODY,
        description: `${slug} budget`,
        activeKey: `NOTE:${slug}`,
        status: 'active',
        confidence: 0.8,
        ...over,
      },
    });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    governance = app.get(MemoryGovernanceService, { strict: false });
    executor = app.get(AssistantToolExecutor, { strict: false });
    registry = app.get(AssistantToolRegistry, { strict: false });
    permissions = app.get(PermissionService, { strict: false });
    note = await noteIn(world.projectId, 'replay-budget');
    deletedNote = await noteIn(world.projectId, 'retired-budget', { deletedAt: new Date() });
    foreignNote = await noteIn(world.opsProjectId, 'ops-budget');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('AC-16: getMemoryItem answers a NOTE of the project by its id', async () => {
    const item = await governance.getMemoryItem(world.projectId, note.id);

    expect(item).toMatchObject({ id: note.id, kind: 'NOTE', subject: 'replay-budget', object: NOTE_BODY });
    expect(item?.description).toBe('replay-budget budget');
  });

  it('AC-16: getMemoryItem answers null for a soft-deleted row of the project', async () => {
    // The row is there and belongs to the project: only `deletedAt` takes it out of the answer.
    expect(await prisma.memoryItem.findUniqueOrThrow({ where: { id: deletedNote.id } }))
      .toMatchObject({ projectId: world.projectId, deletedAt: expect.any(Date) });

    await expect(governance.getMemoryItem(world.projectId, deletedNote.id)).resolves.toBeNull();
  });

  it('AC-16: getMemoryItem answers null for a row of another project', async () => {
    expect(await prisma.memoryItem.findUniqueOrThrow({ where: { id: foreignNote.id } }))
      .toMatchObject({ projectId: world.opsProjectId });

    await expect(governance.getMemoryItem(world.projectId, foreignNote.id)).resolves.toBeNull();
    // The same id read by its own project is answered, so the null above is the project fence, not the row.
    await expect(governance.getMemoryItem(world.opsProjectId, foreignNote.id)).resolves.toMatchObject({ id: foreignNote.id });
  });

  it('AC-16: getMemoryItem answers null for an id that names nothing', async () => {
    await expect(governance.getMemoryItem(world.projectId, 'clnonexistent000000000000')).resolves.toBeNull();
  });

  /** An agent rostered in `web`: the principal its API key would produce (permissions P1 US-001). */
  async function rosteredAgent(): Promise<AgentPrincipal> {
    const agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(prisma, agent.id, world.projectId);
    return {
      actorType: 'agent', id: agent.id, slug: agent.slug, name: 'claude', status: 'ACTIVE',
      agentRoles: [...AGENT_ROLES], capabilities: [], authorities: [], blacklisted: false, revoked: false,
    };
  }

  /** The agent's own MCP registrations: the tools its keys make visible, wired to the executor. */
  async function mcpRegistrations(principal: AgentPrincipal) {
    const visible = await visibleMcpToolNames({ registry, permissions }, principal);

    return { visible, registrations: kodaMcpToolRegistrations(executor, principal, visible) };
  }

  it('AC-17: an agent holding memory.read reads a note of the project through the MCP registration', async () => {
    const principal = await rosteredAgent();
    const { visible, registrations } = await mcpRegistrations(principal);

    // The tool is offered because the agent holds memory.read in web, not because every tool is registered.
    expect(visible.has('koda_get_memory')).toBe(true);
    const registration = registrations.find((entry) => entry.name === 'koda_get_memory');
    expect(registration).toBeDefined();
    expect(registration?.inputSchema).toEqual(
      mcpToolDescriptors().find((descriptor) => descriptor.name === 'koda_get_memory')?.inputSchema,
    );

    const answer = await registration?.handler({ project: 'web', id: note.id });

    expect(answer).toMatchObject({ isError: false });
    const text = (answer as { content: Array<{ text: string }> }).content.map((part) => part.text).join('\n');
    expect(text).toContain(NOTE_BODY);
    expect(text).toContain('replay-budget budget');
    expect(text.split('\n')[0]).toMatch(new RegExp(`^memory:${note.id} NOTE active`));
  });

  it('AC-17: the same registration answers memory item not found for another project, a deleted row or no id', async () => {
    const principal = await rosteredAgent();
    const { registrations } = await mcpRegistrations(principal);
    const registration = registrations.find((entry) => entry.name === 'koda_get_memory');
    if (!registration) throw new Error('koda_get_memory is not registered');

    for (const id of [foreignNote.id, deletedNote.id, 'clnonexistent000000000000']) {
      const answer = (await registration.handler({ project: 'web', id })) as {
        content: Array<{ text: string }>; isError: boolean;
      };

      expect(answer.isError).toBe(false);
      expect(answer.content.map((part) => part.text).join('\n')).toBe('memory item not found');
    }
  });

  it('AC-17: the MCP schema still requires the project, and refuses an id outside its bound', async () => {
    const principal = await rosteredAgent();
    const { registrations } = await mcpRegistrations(principal);
    const registration = registrations.find((entry) => entry.name === 'koda_get_memory');
    if (!registration) throw new Error('koda_get_memory is not registered');

    expect((registration.inputSchema as { required?: string[] }).required).toEqual(['project', 'id']);

    // Argument validation belongs to the executor (B1), so an over-long id is the tool's own refusal.
    const answer = (await registration.handler({ project: 'web', id: 'x'.repeat(65) })) as {
      content: Array<{ text: string }>; isError: boolean;
    };
    expect(answer.isError).toBe(true);
    expect(answer.content.map((part) => part.text).join('\n')).toBe('invalid_input: id');
  });
});
