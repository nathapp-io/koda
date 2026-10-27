import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { currentActor, currentContext, runAsSystem, type ActionContext } from '../../action-context/action-context';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantToolCallRecord, AssistantToolCallRepository } from './assistant-tool-call.domain';
import type { AssistantTool, ToolCaller } from './assistant-tool.types';

const principal: AgentPrincipal = { actorType: 'agent', id: 'claude-id', slug: 'claude', name: 'claude', status: 'ACTIVE', agentRoles: ['DEVELOPER'], capabilities: [], authorities: [], blacklisted: false, revoked: false };
const caller: ToolCaller = { principal, origin: { kind: 'mcp' }, disabled: false };
const threadCall = { jobId: 'j1', toolCallId: 'c1', name: 'koda_get_ticket', input: { ref: 'WEB-1' } };
function setup(workspace = false) {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null),
    findByCall: vi.fn(async () => rows[0] ?? null),
    record: vi.fn(async row => { rows.push(row); }),
    findCallContext: vi.fn(async () => ({ project: { id: 'p1', slug: 'web' }, threadId: 't1', creator: { id: 'u1', email: 'dev@test', role: 'MEMBER', disabled: false } })),
  };
  const tool: AssistantTool = { descriptor: { name: workspace ? 'koda_my_projects' : 'koda_get_ticket', description: '', inputSchema: {} }, scope: workspace ? 'workspace' : 'project', key: workspace ? 'project.read' : 'ticket.read', parse: vi.fn(input => input), execute: vi.fn(async () => 'WEB-1') };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const access = { findProjectIdBySlug: vi.fn(async () => 'p1'), resolveMembership: vi.fn(async (): Promise<string | null> => null) };
  // Permissions P1 US-004: every key is allowed here, so each case stays about the caller's principal and origin.
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  return { executor: new AssistantToolExecutor(registry, calls, access as unknown as ProjectAccessService, permissions), calls, rows, tool, access, permissions };
}
const mcpCall = { name: 'koda_get_ticket', input: { project: 'web', ref: 'WEB-1' } };
describe('caller-based executor', () => {
  it('AC-1: thread adapter uses the creator and context thread/job', async () => {
    const { executor, tool } = setup();
    await executor.execute(threadCall);
    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ id: 'u1' }), threadId: 't1', jobId: 'j1' }), { ref: 'WEB-1' });
  });
  it('AC-2: replay precedes context lookup', async () => {
    const { executor, calls } = setup();
    await executor.execute(threadCall);
    vi.mocked(calls.findCallContext).mockClear();
    expect(await executor.execute(threadCall)).toEqual({ content: 'WEB-1', isError: false });
    expect(calls.findCallContext).not.toHaveBeenCalled();
  });
  it('AC-3, AC-4: MCP uses the agent and resolved project with no thread or job', async () => {
    const { executor, tool, access } = setup();
    expect(await executor.executeFor(caller, mcpCall)).toEqual({ content: 'WEB-1', isError: false });
    expect(access.resolveMembership).toHaveBeenCalledWith('p1', principal);
    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: principal, projectSlug: 'web', threadId: null, jobId: null }), { ref: 'WEB-1' });
  });
  it('AC-5, AC-8: missing project is invalid and audited without a project', async () => {
    const { executor, rows, tool } = setup();
    expect(await executor.executeFor(caller, { name: mcpCall.name, input: {} })).toEqual({ content: 'invalid_input: project', isError: true });
    expect(rows[0]?.projectId).toBeNull();
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it('AC-6: my projects needs no project and uses empty scope', async () => {
    const { executor, tool } = setup(true);
    await executor.executeFor(caller, { name: 'koda_my_projects', input: {} });
    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ projectId: '', projectSlug: '' }), {});
  });
  it('AC-7: each MCP call audits the agent, with no replay or thread lookup', async () => {
    const { executor, calls, rows } = setup();
    await executor.executeFor(caller, mcpCall);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'agent', actorId: principal.id, jobId: null, threadId: null, toolCallId: null });
    await executor.executeFor(caller, mcpCall);
    expect(rows).toHaveLength(2);
    expect(calls.findByCall).not.toHaveBeenCalled();
    expect(calls.findCallContext).not.toHaveBeenCalled();
  });
  it('unknown MCP tools throw before scope resolution', async () => {
    const { executor, access } = setup();
    await expect(executor.executeFor(caller, { name: 'unknown', input: {} })).rejects.toBeInstanceOf(NotFoundAppException);
    expect(access.resolveMembership).not.toHaveBeenCalled();
  });
  it('unreachable project is hidden', async () => {
    const { executor, access, tool } = setup();
    access.resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    expect(await executor.executeFor(caller, mcpCall)).toEqual({ content: 'not_found: project', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it('an agent whose catalog key is refused is refused the call, and CASL is not consulted', async () => {
    const { executor, tool, permissions } = setup();
    vi.mocked(permissions.can).mockResolvedValueOnce({ allowed: false, reason: 'not-granted' });
    tool.key = 'fleet.job.dispatch';
    expect(await executor.executeFor(caller, mcpCall)).toEqual({ content: 'forbidden: koda_get_ticket needs fleet.job.dispatch on web', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
    // The key is asked for the agent itself, in the project the call resolved (permissions P1 US-004).
    expect(permissions.can).toHaveBeenCalledWith(principal, 'fleet.job.dispatch', { projectId: 'p1' });
  });
});

/**
 * Permissions P2 US-003: an MCP call is the caller's own action — the key holder, over the MCP route — so it runs in
 * a context whose actor is that principal and whose origin is `mcp`, whether or not the MCP request already sits
 * inside one (the HTTP interceptor's `SYSTEM/anonymous` context for a request without a principal, for instance).
 */
const mcpAgent: AgentPrincipal = { ...principal, id: 'a1', name: 'a1', slug: 'a1' };
const mcpUser: UserPrincipal = {
  actorType: 'user', id: 'u1', name: 'u1@koda.test', email: 'u1@koda.test', role: 'MEMBER',
  blacklisted: false, revoked: false, authorities: ['MEMBER'], extra: { sub: 'u1', email: 'u1@koda.test', role: 'MEMBER' },
};
const mcpCaller = (who: AgentPrincipal | UserPrincipal): ToolCaller => ({ principal: who, origin: { kind: 'mcp' }, disabled: false });

describe('Permissions P2 US-003: an MCP call runs in its own action context', () => {
  it("AC-10: an MCP call inside a SYSTEM/anonymous context runs the tool with origin 'mcp'", async () => {
    const seen: Array<ActionContext | undefined> = [];
    const { executor, tool } = setup();
    vi.mocked(tool.execute).mockImplementation(async () => { seen.push(currentContext()); return 'WEB-1'; });

    await runAsSystem('anonymous', () => executor.executeFor(mcpCaller(mcpAgent), mcpCall));

    expect(seen.map((context) => context?.origin)).toEqual(['mcp']);
  });

  it('AC-10: the enclosing context is restored once the MCP call returns', async () => {
    const { executor } = setup();

    await runAsSystem('anonymous', async () => {
      await executor.executeFor(mcpCaller(mcpAgent), mcpCall);
      expect(currentActor()).toEqual({ type: 'SYSTEM', id: 'anonymous' });
    });
  });

  it('AC-11: that MCP call runs as the calling agent a1, not the enclosing context', async () => {
    const seen: Array<ActionContext | undefined> = [];
    const { executor, tool } = setup();
    vi.mocked(tool.execute).mockImplementation(async () => { seen.push(currentContext()); return 'WEB-1'; });

    await runAsSystem('anonymous', () => executor.executeFor(mcpCaller(mcpAgent), mcpCall));

    expect(seen.map((context) => context?.actor)).toEqual([{ type: 'AGENT', id: 'a1' }]);
  });

  it('AC-12: an MCP call with no context current runs the tool as the calling user u1', async () => {
    const seen: Array<ActionContext | undefined> = [];
    const { executor, tool } = setup();
    vi.mocked(tool.execute).mockImplementation(async () => { seen.push(currentContext()); return 'WEB-1'; });
    expect(currentContext()).toBeUndefined();

    await executor.executeFor(mcpCaller(mcpUser), mcpCall);

    expect(seen.map((context) => context?.actor)).toEqual([{ type: 'USER', id: 'u1' }]);
    expect(currentContext()).toBeUndefined();
  });
});
