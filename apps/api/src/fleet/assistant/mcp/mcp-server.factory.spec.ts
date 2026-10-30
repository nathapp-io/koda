import { Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../../auth/principal/koda-principal.types';
import type { AssistantToolRegistry } from '../assistant-tool.registry';
import type { AssistantTool } from '../assistant-tool.types';
import { createKodaMcpServer, kodaMcpToolRegistrations, visibleMcpToolNames } from './mcp-server.factory';
import { mcpToolDescriptors } from './mcp-tool-catalog';

const principal = { actorType: 'agent', id: 'agent-1', slug: 'claude' } as unknown as AgentPrincipal;

/** US-005: every descriptor's name, the set a caller that holds every key is answered. */
const ALL_TOOLS: ReadonlySet<string> = new Set(mcpToolDescriptors().map((descriptor) => descriptor.name));

describe('kodaMcpToolRegistrations', () => {
  const executeFor = vi.fn();

  beforeEach(() => {
    executeFor.mockReset();
    executeFor.mockResolvedValue({ content: 'ok', isError: false });
  });

  it('AC-5 (US-005): registers only the tool whose name the visible set names', () => {
    const registrations = kodaMcpToolRegistrations({ executeFor }, principal, new Set(['koda_get_ticket']));

    expect(registrations.map((r) => r.name)).toEqual(['koda_get_ticket']);
  });

  it('AC-15: answers one registration per mcpToolDescriptors() entry, in order', () => {
    const registrations = kodaMcpToolRegistrations({ executeFor }, principal, ALL_TOOLS);

    expect(registrations.map((r) => r.name)).toEqual(mcpToolDescriptors().map((d) => d.name));
    expect(registrations.map((r) => r.description)).toEqual(mcpToolDescriptors().map((d) => d.description));
  });

  it('a handler calls executeFor as the agent with an mcp origin and answers the MCP tool result', async () => {
    const [first] = kodaMcpToolRegistrations({ executeFor }, principal, ALL_TOOLS);

    const answer = await first.handler({ project: 'web' });

    expect(executeFor).toHaveBeenCalledWith(
      { principal, origin: { kind: 'mcp' }, disabled: false },
      { name: first.name, input: { project: 'web' } },
    );
    expect(answer).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
  });

  it('US-004: the assistant approval tool is not registered over MCP and dispatches under its own name', async () => {
    // The engine's ApprovalMcpTools owns `koda_list_approvals` over MCP, so neither the assistant name nor the
    // retired `koda_list_fleet_approvals` alias is registered from the registry — even for an agent holding its key.
    const registryGet = vi.fn((name: string) => (name === 'koda_get_ticket' ? { key: 'ticket.read' } as AssistantTool : undefined));
    const visible = await visibleMcpToolNames({
      registry: { get: registryGet },
      permissions: { projectIdsWithKey: vi.fn(async () => ({ all: false as const, projectIds: ['p1'] })) },
    }, principal);
    expect([...visible]).toEqual(['koda_get_ticket']);
    expect(registryGet).not.toHaveBeenCalledWith('koda_list_approvals');

    const [registration] = kodaMcpToolRegistrations({ executeFor }, principal, ALL_TOOLS)
      .filter((entry) => entry.name === 'koda_get_ticket');
    // Every registered name is dispatched unchanged: no alias map is applied on the way to the executor.
    await registration?.handler({ project: 'web' });
    expect(executeFor).toHaveBeenCalledWith(
      { principal, origin: { kind: 'mcp' }, disabled: false },
      { name: 'koda_get_ticket', input: { project: 'web' } },
    );
  });

  it('a handler whose executeFor throws logs the error and answers `error: <name> failed`', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    executeFor.mockRejectedValue(new Error('boom'));
    const [first] = kodaMcpToolRegistrations({ executeFor }, principal, ALL_TOOLS);

    const answer = await first.handler({});

    expect(answer).toEqual({ content: [{ type: 'text', text: `error: ${first.name} failed` }], isError: true });
    expect(logError).toHaveBeenCalled();
    logError.mockRestore();
  });
});

describe('visibleMcpToolNames', () => {
  /** A registry stub keyed by tool name, answering the tools the real registry holds for these names. */
  const registryOf = (tools: Record<string, AssistantTool>): Pick<AssistantToolRegistry, 'get'> =>
    ({ get: (name: string) => tools[name] });
  const tool = (key: string, scope?: 'project' | 'workspace'): AssistantTool =>
    ({ key, ...(scope === undefined ? {} : { scope }) }) as unknown as AssistantTool;
  const permissionsWith = (projects: Record<string, string[]>) =>
    vi.fn(async (_principal: unknown, key: string) =>
      projects[key] === undefined ? { all: false as const, projectIds: [] } : { all: false as const, projectIds: projects[key] },
    );

  it('US-005: an agent holding nothing still sees the workspace tool and the implicit-key tool', async () => {
    const permissions = { projectIdsWithKey: permissionsWith({}) };

    const visible = await visibleMcpToolNames(
      {
        registry: registryOf({
          koda_my_projects: tool('project.read', 'workspace'),
          koda_get_action: tool('assistant.action.read'),
          koda_get_ticket: tool('ticket.read'),
        }),
        permissions,
      },
      principal,
    );

    expect([...visible].sort()).toEqual(['koda_get_action', 'koda_my_projects']);
    // Only the one project key is asked about: a workspace tool and an implicit key take no project.
    expect(permissions.projectIdsWithKey.mock.calls.map(([, key]) => key)).toEqual(['ticket.read']);
  });

  it('US-005: a key held in one project makes its tools visible, and one distinct query answers both', async () => {
    const visible = await visibleMcpToolNames(
      {
        registry: registryOf({
          koda_search_tickets: tool('ticket.read'),
          koda_get_ticket: tool('ticket.read'),
          koda_dispatch_job: tool('fleet.job.dispatch'),
        }),
        permissions: { projectIdsWithKey: permissionsWith({ 'ticket.read': ['p1'] }) },
      },
      principal,
    );

    expect([...visible].sort()).toEqual(['koda_get_ticket', 'koda_search_tickets']);
  });

  it('US-005: a key held globally lists every tool on it, and a name the registry does not hold is never visible', async () => {
    const visible = await visibleMcpToolNames(
      {
        registry: registryOf({ koda_dispatch_job: tool('fleet.job.dispatch') }),
        permissions: { projectIdsWithKey: vi.fn(async () => ({ all: true as const })) },
      },
      principal,
    );

    expect([...visible]).toEqual(['koda_dispatch_job']);
  });
});

describe('createKodaMcpServer', () => {
  it('builds a server named koda that accepts every registration', () => {
    const registrations = kodaMcpToolRegistrations({ executeFor: vi.fn() }, principal, ALL_TOOLS);

    expect(() => createKodaMcpServer(registrations)).not.toThrow();
  });
});
