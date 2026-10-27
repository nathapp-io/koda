import { gateDouble } from '../../../test/helpers/assistant-gate-double';
import { Logger } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { currentContext } from '../../action-context/action-context';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { PermissionService } from '../../permissions/permission.service';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantToolCallRecord, AssistantToolCallRepository } from './assistant-tool-call.domain';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolCaller } from './assistant-tool.types';

const principal: AgentPrincipal = { actorType: 'agent', id: 'claude-id', slug: 'claude', name: 'claude', status: 'ACTIVE', agentRoles: ['DEVELOPER'], capabilities: [], authorities: [], blacklisted: false, revoked: false };
const caller: ToolCaller = { principal, origin: { kind: 'mcp' }, disabled: false };
const call = { name: 'koda_add_comment', input: { project: 'web', ref: 'WEB-1', body: 'from mcp' } };
const text = 'comment c1 added to WEB-1 /web/tickets/WEB-1';
function setup() {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findAgentActor: vi.fn(async () => null), findProjectSlug: vi.fn(async () => null),
    findUserActor: vi.fn(async () => null), findByCall: vi.fn(async () => null), findCallContext: vi.fn(async () => null),
    record: vi.fn(async row => { rows.push(row); }),
  };
  const preview = vi.fn(async () => 'Add comment preview');
  const tool: AssistantTool = { descriptor: { name: call.name, description: '', inputSchema: {} }, kind: 'write', key: 'comment.create', parse: vi.fn(input => input), preview, execute: vi.fn(async () => text) };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const permissions = { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } as unknown as PermissionService;
  const doubles = gateDouble('none');
  const gate = vi.spyOn(doubles.deps[0], 'gate').mockResolvedValue({ status: 'executed', result: { text } });
  const executor = new AssistantToolExecutor(registry, calls, { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => null } as unknown as ProjectAccessService, permissions, ...doubles.deps);
  return { executor, tool, preview, rows, permissions, ...doubles, gate };
}
describe('MCP writes through the approval gate', () => {
  it('passes parsed input and the agent context to the gate after preview, without a lock, transaction or link', async () => {
    const { executor, gate, preview, resolver, links, tx, tool } = setup();
    gate.mockImplementation(async () => {
      expect(currentContext()).toMatchObject({ actor: { type: 'AGENT', id: principal.id }, origin: 'mcp' });
      expect(currentContext()?.onBehalfOf).toBeUndefined();
      return { status: 'executed', result: { text } };
    });
    expect(await executor.executeFor(caller, call)).toEqual({ content: text, isError: false });
    expect(gate).toHaveBeenCalledExactlyOnceWith('comment.create', { projectId: 'p1', threadId: null, jobId: null, args: { ref: 'WEB-1', body: 'from mcp' } }, { projectId: 'p1' });
    expect(preview.mock.invocationCallOrder[0]).toBeLessThan(Number(gate.mock.invocationCallOrder[0]));
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(tx.run).not.toHaveBeenCalled();
    expect(links.lockThread).not.toHaveBeenCalled();
    expect(links.insert).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it('answers a pending gate result without error and audits pending', async () => {
    const { executor, gate, rows, links } = setup();
    gate.mockResolvedValue({ status: 'pending', request: { id: 'r1' } } as never);
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'pending r1: awaiting approval; do not retry', isError: false });
    expect(rows[0]).toMatchObject({ outcome: 'pending', isError: false });
    expect(links.insert).not.toHaveBeenCalled();
  });
  it('AC-11: maps and logs a plain gate error', async () => {
    const { executor, gate, rows } = setup();
    const error = new Error('unexpected');
    const log = vi.spyOn(Logger.prototype, 'error');
    log.mockClear();
    gate.mockRejectedValue(error);
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'error: koda_add_comment failed', isError: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('koda_add_comment failed'), error.stack);
    expect(rows[0]).toMatchObject({ outcome: 'error', isError: true });
  });
  it.each([
    [new NotFoundAppException({}, 'tickets'), 'not_found'],
    [new ToolActionError('partial write ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'partial write [masked]'],
  ])('maps gate failure %s', async (error, content) => {
    const { executor, gate } = setup();
    gate.mockRejectedValue(error);
    expect(await executor.executeFor(caller, call)).toEqual({ content, isError: true });
  });
  it.each([
    [new NotFoundAppException({}, 'tickets'), 'not_found'],
    [new ToolInputError('ref'), 'invalid_input: ref'],
    [new ToolForbiddenError('comment.create'), 'forbidden: koda_add_comment needs comment.create on web'],
  ])('preview refusal precedes the gate: %s', async (error, content) => {
    const { executor, gate, preview } = setup();
    preview.mockRejectedValue(error);
    expect(await executor.executeFor(caller, call)).toEqual({ content, isError: true });
    expect(gate).not.toHaveBeenCalled();
  });
  it('a refused key never previews or gates', async () => {
    const { executor, gate, preview, permissions } = setup();
    vi.mocked(permissions.can).mockResolvedValue({ allowed: false, reason: 'not-granted' });
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'forbidden: koda_add_comment needs comment.create on web', isError: true });
    expect(gate).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });
});
