import { NotFoundAppException } from '@nathapp/nestjs-common';
import { currentContext } from '../../action-context/action-context';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { MemoryWriteService } from '../memory-write.service';
import { MemoryMcpTools } from './memory-mcp-tools';

const agent = { actorType: 'agent', id: 'agent-1', slug: 'agent' } as AgentPrincipal;

describe('MemoryMcpTools', () => {
  const retireTarget = vi.fn();
  const run = vi.fn();
  const tools = () => new MemoryMcpTools(
    { retireTarget } as unknown as MemoryWriteService,
    { run } as unknown as ApprovalRouteGate,
  );
  const registration = () => {
    const found = tools().registrations(agent).find(({ name }) => name === 'koda_retire_decision');
    if (!found) throw new Error('missing retire decision tool');
    return found;
  };
  const call = (input: unknown) => registration().handler(input);

  beforeEach(() => {
    retireTarget.mockReset();
    retireTarget.mockResolvedValue({ projectId: 'project-1' });
    run.mockReset();
    run.mockResolvedValue({ status: 'executed', result: { id: 'm1' }, approval: {} });
  });

  it('AC-1: registers a required id and optional reason schema', () => {
    expect(registration().inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, reason: { type: 'string', maxLength: 500 } },
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('AC-2: finds the target then calls the shared gate from an agent MCP context', async () => {
    run.mockImplementation(async () => {
      expect(currentContext()).toMatchObject({ actor: { type: 'AGENT', id: agent.id }, origin: 'mcp' });
      return { status: 'executed', result: { id: 'm1' }, approval: {} };
    });
    await call({ id: 'm1', reason: 'obsolete' });
    expect(retireTarget).toHaveBeenCalledWith(agent, 'm1');
    expect(run).toHaveBeenCalledWith({
      key: 'memory.decision.retire', variant: 'rest:memory.decision.retire', projectId: 'project-1',
      input: { id: 'm1', body: { reason: 'obsolete' } },
    });
  });

  it('AC-3: reports a completed retirement without an error', async () => {
    run.mockResolvedValue({ status: 'done', result: { id: 'm1' } });
    const answer = await call({ id: 'm1' });
    expect(answer.content[0]?.text).toContain('retired m1');
    expect(answer.isError).toBe(false);
  });

  it('handles the live executed gate success outcome', async () => {
    const answer = await call({ id: 'm1' });
    expect(answer.content[0]?.text).toContain('retired m1');
    expect(answer.isError).toBe(false);
  });

  it('AC-4: reports a pending approval request id', async () => {
    run.mockResolvedValue({ status: 'pending', request: { id: 'request-1' } });
    const answer = await call({ id: 'm1' });
    expect(answer.content[0]?.text).toContain('request-1');
    expect(answer.isError).toBe(false);
  });

  it('AC-5: rejects an unknown input key', async () => {
    const answer = await call({ id: 'm1', force: true });
    expect(answer).toMatchObject({ content: [{ text: 'invalid_input: force' }], isError: true });
    expect(retireTarget).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('AC-6: maps a missing decision to a safe not-found answer', async () => {
    retireTarget.mockRejectedValue(new NotFoundAppException({}, 'memory.notFound'));
    const answer = await call({ id: 'm1' });
    expect(answer.content[0]?.text).toContain('not found');
    expect(answer.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});
