import { NotFoundAppException } from '@nathapp/nestjs-common';
import { KodaCaslAbilityFactory } from '../../auth/casl/koda-casl-ability.factory';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { ProjectAccessService } from '../../projects/project-access.service';
import { approvalModeFor } from './actions/approval-policy';
import type { ActionProposer } from './actions/pending-action.domain';
import { AssistantToolExecutor, RESULT_CAP_BYTES } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantToolCallRecord, AssistantToolCallRepository } from './assistant-tool-call.domain';
import { ToolActionError, ToolForbiddenError, ToolInputError, type AssistantTool, type ToolCaller } from './assistant-tool.types';

vi.mock('./actions/approval-policy', () => ({ approvalModeFor: vi.fn(() => 'none') }));
const principal: AgentPrincipal = { actorType: 'agent', id: 'claude-id', slug: 'claude', name: 'claude', status: 'ACTIVE', agentRoles: ['DEVELOPER'], capabilities: [], authorities: [], blacklisted: false, revoked: false };
const caller: ToolCaller = { principal, origin: { kind: 'mcp' }, disabled: false };
const call = { name: 'koda_add_comment', input: { project: 'web', ref: 'WEB-1', body: 'from mcp' } };
const text = 'comment c1 added to WEB-1 /web/tickets/WEB-1';
function setup() {
  const rows: AssistantToolCallRecord[] = [];
  const calls: AssistantToolCallRepository = {
    findUserActor: vi.fn(async () => null), findByCall: vi.fn(async () => null), findCallContext: vi.fn(async () => null),
    record: vi.fn(async row => { rows.push(row); }),
  };
  const preview = vi.fn(async () => 'Add comment preview');
  const tool: AssistantTool = { descriptor: { name: call.name, description: '', inputSchema: {} }, kind: 'write', permission: { kind: 'ability', action: 'create', subject: 'Comment' }, parse: vi.fn(input => input), preview, execute: vi.fn(async () => text) };
  const registry = new AssistantToolRegistry();
  registry.register(tool);
  const actions: ActionProposer = { propose: vi.fn(async () => ({ actionId: 'p1' })), recordDirect: vi.fn(async () => ({ actionId: 'a1' })) };
  const executor = new AssistantToolExecutor(registry, calls, { findProjectIdBySlug: async () => 'p1', resolveMembership: async () => null } as unknown as ProjectAccessService, new KodaCaslAbilityFactory());
  executor.attachActions(actions);
  return { executor, tool, preview, actions, rows };
}
describe('direct assistant writes', () => {
  beforeEach(() => vi.mocked(approvalModeFor).mockReset().mockReturnValue('none'));
  it('AC-1: executes once as the caller without proposing; policy precedes preview', async () => {
    const { executor, tool, preview, actions } = setup();
    await executor.executeFor(caller, call);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: principal, threadId: null, jobId: null }), { ref: 'WEB-1', body: 'from mcp' });
    expect(actions.propose).not.toHaveBeenCalled();
    expect(approvalModeFor).toHaveBeenCalledExactlyOnceWith(caller.origin, call.name);
    expect(vi.mocked(approvalModeFor).mock.invocationCallOrder[0]).toBeLessThan(Number(preview.mock.invocationCallOrder[0]));
  });
  it('AC-2: returns the outcome and action suffix', async () => {
    const { executor } = setup();
    expect(await executor.executeFor(caller, call)).toEqual({ content: `${text}\naction a1`, isError: false });
  });
  it('AC-3: records a partial tool failure', async () => {
    const { executor, tool, actions } = setup();
    vi.mocked(tool.execute).mockRejectedValue(new ToolActionError('dispatch refused: open PR on WEB-1'));
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'dispatch refused: open PR on WEB-1\naction a1', isError: true });
    expect(actions.recordDirect).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', result: 'dispatch refused: open PR on WEB-1' }));
  });
  it('AC-4: preview invalid input neither writes nor records', async () => {
    const { executor, tool, preview, actions } = setup();
    preview.mockRejectedValue(new ToolInputError('ref'));
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'invalid_input: ref', isError: true });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(actions.recordDirect).not.toHaveBeenCalled();
  });
  it.each(['self', 'agent', 'human'] as const)('AC-5: refuses unsupported MCP mode %s before preview', async mode => {
    const { executor, tool, actions } = setup();
    vi.mocked(approvalModeFor).mockReturnValue(mode);
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'error: koda_add_comment failed', isError: true });
    expect(tool.preview).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
    expect(actions.recordDirect).not.toHaveBeenCalled();
  });
  it('AC-6: records the caller, origin, parsed input and preview', async () => {
    const { executor, actions } = setup();
    await executor.executeFor(caller, call);
    expect(actions.recordDirect).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', tool: call.name, input: { ref: 'WEB-1', body: 'from mcp' }, preview: 'Add comment preview', actorType: 'agent', actorId: principal.id, origin: 'mcp', status: 'EXECUTED', result: text, now: expect.any(Date) });
  });
  it('AC-7: masks secrets before recording and answering', async () => {
    const { executor, tool, actions } = setup();
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    vi.mocked(tool.execute).mockResolvedValue(`done ${token}`);
    const result = await executor.executeFor(caller, call);
    expect(actions.recordDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(actions.recordDirect).mock.calls[0]?.[0].result).toBe('done [masked]');
    expect(result.content).not.toContain(token);
  });
  it('AC-8: caps a 20000-byte outcome and preserves the suffix', async () => {
    const { executor, tool, actions } = setup();
    vi.mocked(tool.execute).mockResolvedValue('é'.repeat(10000));
    const result = await executor.executeFor(caller, call);
    expect(result.content.endsWith('\naction a1')).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(RESULT_CAP_BYTES);
    expect(actions.recordDirect).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(vi.mocked(actions.recordDirect).mock.calls[0]?.[0].result ?? '')).toBeLessThanOrEqual(RESULT_CAP_BYTES - 64);
  });
  it('AC-9: a failed record does not retry the completed write', async () => {
    const { executor, tool, actions } = setup();
    vi.mocked(actions.recordDirect).mockRejectedValue(new Error('database unavailable'));
    expect(await executor.executeFor(caller, call)).toEqual({ content: 'error: koda_add_comment failed (the change was made but its action was not recorded)', isError: true });
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });
  it('AC-10: audits executed as ok, not an error', async () => {
    const { executor, rows } = setup();
    await executor.executeFor(caller, call);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'ok', isError: false });
  });
  it('AC-11: audits ToolActionError as error', async () => {
    const { executor, tool, rows } = setup();
    vi.mocked(tool.execute).mockRejectedValue(new ToolActionError('partial write'));
    await executor.executeFor(caller, call);
    expect(rows[0]).toMatchObject({ outcome: 'error', isError: true, content: 'partial write\naction a1' });
  });
  it.each([new NotFoundAppException({}, 'tickets'), new Error('unexpected')])('records mapped execute failure %s', async error => {
    const { executor, tool, actions, rows } = setup();
    vi.mocked(tool.execute).mockRejectedValue(error);
    await executor.executeFor(caller, call);
    const missing = error instanceof NotFoundAppException;
    expect(actions.recordDirect).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', result: missing ? 'not_found' : 'error: koda_add_comment failed' }));
    expect(rows[0]).toMatchObject({ outcome: missing ? 'not_found' : 'error', isError: true });
  });
  it.each([new NotFoundAppException({}, 'tickets'), new ToolForbiddenError('create Comment')])('preview refusal creates no action %s', async error => {
    const { executor, tool, preview, actions } = setup();
    preview.mockRejectedValue(error);
    const result = await executor.executeFor(caller, call);
    expect(result).toEqual({ content: error instanceof NotFoundAppException ? 'not_found' : 'forbidden: koda_add_comment needs create Comment on web', isError: true });
    expect(actions.recordDirect).not.toHaveBeenCalled();
    expect(tool.execute).not.toHaveBeenCalled();
  });
  it('denied ability does not consult policy or preview', async () => {
    const { executor, tool } = setup();
    tool.permission = { kind: 'ability', action: 'create', subject: 'FleetJob' };
    expect((await executor.executeFor(caller, call)).isError).toBe(true);
    expect(approvalModeFor).not.toHaveBeenCalled();
    expect(tool.preview).not.toHaveBeenCalled();
  });
});
