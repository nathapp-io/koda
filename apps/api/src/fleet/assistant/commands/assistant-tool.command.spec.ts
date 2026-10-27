import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { runWithActionContext } from '../../../action-context/action-context';
import { agentPrincipal, RESULT_CAP_BYTES } from '../assistant-tool.executor';
import { capText, maskSecrets } from '../assistant-tool-safety';
import { KODA_ADD_COMMENT } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { assistantToolCommand, AssistantCommandRefusedError, type AssistantCommandDeps } from './assistant-tool.command';

const input = { projectId: 'p1', threadId: 't1', jobId: 'j1', args: { body: 'hello' } };
function setup() {
  const calls = { findUserActor: vi.fn().mockResolvedValue({ id: 'u1', email: 'u@test', role: 'MEMBER', disabled: false }), findAgentActor: vi.fn().mockResolvedValue({ type: 'AGENT', id: 'a1', slug: 'agent', status: 'ONLINE' }), findProjectSlug: vi.fn().mockResolvedValue('project') };
  const access = { resolveMembership: vi.fn().mockResolvedValue(null) };
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const tool: AssistantTool = { descriptor: KODA_ADD_COMMENT, key: 'comment.create', kind: 'write', parse: vi.fn((args) => args), execute: vi.fn().mockResolvedValue('ok') };
  const command = assistantToolCommand(tool, { calls, access, permissions } as unknown as AssistantCommandDeps);
  const run = () => runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u1' }, origin: 'thread' }, () => command.execute(input));
  return { calls, access, permissions, tool, command, run };
}
describe('assistantToolCommand', () => {
  it('AC-2: uses the tool key', () => { const s = setup(); expect(s.command.key).toBe(s.tool.key); });
  it('AC-3: parses domain input and nullable provenance', () => {
    const s = setup();
    const parsedArgs = { body: 'normalized' };
    vi.mocked(s.tool.parse).mockReturnValue(parsedArgs);
    expect(s.command.parse(input)).toEqual({ ...input, args: parsedArgs });
    expect(s.tool.parse).toHaveBeenCalledWith(input.args);
    expect(s.command.parse({ ...input, threadId: null, jobId: null })).toEqual({ ...input, threadId: null, jobId: null, args: parsedArgs });
  });
  it.each([undefined, null, 2, ''])('AC-4: rejects invalid projectId %s', (projectId) => { expect(() => setup().command.parse({ ...input, projectId })).toThrow(); });
  it.each(['threadId', 'jobId'])('AC-5: rejects invalid %s', (field) => { for (const value of [undefined, 1, {}, false]) expect(() => setup().command.parse({ ...input, [field]: value })).toThrow(); });
  it('AC-6: preserves parser errors', () => { const s = setup(); const error = new ToolInputError('body'); vi.mocked(s.tool.parse).mockImplementation(() => { throw error; }); expect(() => s.command.parse(input)).toThrow(error); });
  it('AC-8: reconstructs user and scoped context, fresh fences and lazy can', async () => {
    const s = setup(); await s.run(); const ctx = vi.mocked(s.tool.execute).mock.calls[0][0];
    expect(ctx).toMatchObject({ actor: { id: 'u1' }, projectId: 'p1', projectSlug: 'project', threadId: 't1', jobId: 'j1', now: expect.any(Date) });
    expect(s.calls.findUserActor).toHaveBeenCalledWith('u1'); expect(s.access.resolveMembership).toHaveBeenCalledWith('p1', ctx.actor);
    expect(s.permissions.can).not.toHaveBeenCalled(); expect(await ctx.can('ticket.update')).toBe(true); expect(s.permissions.can).toHaveBeenCalledWith(ctx.actor, 'ticket.update', { projectId: 'p1' });
    await s.run(); const next: ToolContext = vi.mocked(s.tool.execute).mock.calls[1][0]; expect(next.data('text')).not.toBe(ctx.data('text')); expect(ctx.data('text')).toBe(ctx.data('text'));
  });
  it('AC-9: reconstructs agent actor', async () => { const s = setup(); await runWithActionContext({ actor: { type: 'AGENT', id: 'a1' }, origin: 'mcp' }, () => s.command.execute(input)); expect(s.calls.findAgentActor).toHaveBeenCalledWith('a1'); expect(vi.mocked(s.tool.execute).mock.calls[0][0].actor).toEqual(agentPrincipal(await s.calls.findAgentActor())); });
  it.each(['missing', 'disabled', 'paused', 'membership', 'missing-agent', 'no-context', 'system'])('AC-10: refuses %s without execution', async (reason) => {
    const s = setup();
    if (reason === 'missing') s.calls.findUserActor.mockResolvedValue(null);
    if (reason === 'disabled') s.calls.findUserActor.mockResolvedValue({ id: 'u1', disabled: true });
    if (reason === 'paused') s.calls.findAgentActor.mockResolvedValue({ type: 'AGENT', id: 'a1', slug: 'agent', status: 'PAUSED' });
    if (reason === 'missing-agent') s.calls.findAgentActor.mockResolvedValue(null);
    if (reason === 'membership') s.access.resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    const run = reason === 'paused' || reason === 'missing-agent' ? () => runWithActionContext({ actor: { type: 'AGENT', id: 'a1' }, origin: 'mcp' }, () => s.command.execute(input)) : reason === 'no-context' ? () => s.command.execute(input) : reason === 'system' ? () => runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, origin: 'thread' }, () => s.command.execute(input)) : s.run;
    await expect(run()).rejects.toBeInstanceOf(AssistantCommandRefusedError); expect(s.tool.execute).not.toHaveBeenCalled();
  });
  it('missing project throws not found', async () => { const s = setup(); s.calls.findProjectSlug.mockResolvedValue(null); await expect(s.run()).rejects.toBeInstanceOf(NotFoundAppException); expect(s.tool.execute).not.toHaveBeenCalled(); });
  it('AC-11: masks and byte caps results', async () => { const s = setup(); const text = 'ghp_123456789012345678901234567890123456 ' + '界'.repeat(20000); vi.mocked(s.tool.execute).mockResolvedValue(text); const result = await s.run(); expect(result).toEqual({ text: capText(maskSecrets(text), RESULT_CAP_BYTES) }); expect(result.text).not.toContain('ghp_123456'); expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(RESULT_CAP_BYTES); });
  it.each([new NotFoundAppException({}, 'projects'), new ToolActionError('partial'), new Error('boom')])('AC-12: rethrows same error', async (error) => { const s = setup(); vi.mocked(s.tool.execute).mockRejectedValue(error); await expect(s.run()).rejects.toBe(error); });
  it('AC-13: returns result unchanged', () => { const s = setup(); const result = { text: 'ok' }; expect(s.command.toResult?.(result)).toBe(result); });
});
