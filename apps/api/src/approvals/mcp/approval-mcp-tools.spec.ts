import { Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { currentContext } from '../../action-context/action-context';
import { ApprovalRequestQueries } from '../approval-request.queries';
import { ApprovalDecisionService } from '../approval-decision.service';
import { ApprovalMcpTools } from './approval-mcp-tools';

const agent = { actorType: 'agent', id: 'agent-1', slug: 'agent' } as AgentPrincipal;
describe('ApprovalMcpTools list', () => {
  const list = vi.fn();
  const tools = () => new ApprovalMcpTools({ list } as unknown as ApprovalRequestQueries, {} as ApprovalDecisionService);
  const registration = () => {
    const tool = tools().registrations(agent)[0];
    if (!tool) throw new Error('missing inbox registration');
    return tool;
  };
  const call = (input: unknown = {}) => registration().handler(input);
  beforeEach(() => { list.mockReset(); list.mockResolvedValue({ records: [], current: 1, hasNext: false }); });
  it('AC-1: registers only the inbox with its advertised schema', () => {
    const registrations = tools().registrations(agent);
    expect(registrations.map(({ name }) => name)).toEqual(['koda_list_approvals']);
    expect(registration().inputSchema).toEqual({ type: 'object', properties: {
      status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'failed'] },
      mine: { type: 'boolean' }, page: { type: 'integer', minimum: 1 },
    }, additionalProperties: false });
  });
  it('AC-2/3: passes filters and page inside the agent MCP context', async () => {
    list.mockImplementation(async () => {
      const ctx = currentContext();
      expect({ actorType: ctx?.actor.type, actorId: ctx?.actor.id, origin: ctx?.origin }).toEqual({ actorType: 'AGENT', actorId: agent.id, origin: 'mcp' });
      return { records: [], hasNext: false };
    });
    await call({ status: 'pending', mine: true, page: 2 });
    expect(list).toHaveBeenCalledWith({ type: 'AGENT', id: agent.id }, { status: 'pending', mine: true }, { current: 2, size: 20 });
  });
  it.each(['project-1', null])('AC-4: formats requests and next page (project=%s)', async (projectId) => {
    list.mockResolvedValue({ records: [{ id: 'request-1', status: 'pending', permissionKey: 'label.delete', projectId,
      actor: { type: 'AGENT', id: agent.id }, requiredMode: 'human', expiresAt: new Date('2026-11-01T00:00:00Z') }], current: 2, hasNext: true });
    expect(await call({ page: 2 })).toEqual({ content: [{ type: 'text', text: `request-1 pending label.delete project=${projectId ?? 'global'} actor=AGENT/agent-1 requires=human expires=2026-11-01T00:00:00.000Z\nnext page: 3` }], isError: false });
  });
  it('AC-5: empty page and default pagination', async () => {
    expect(await call()).toEqual({ content: [{ type: 'text', text: 'no approval requests' }], isError: false });
    expect(list).toHaveBeenCalledWith({ type: 'AGENT', id: agent.id }, { status: undefined, mine: undefined }, { current: 1, size: 20 });
  });
  it.each([
    [{ status: 'bogus' }, 'status'], [{ page: 0 }, 'page'], [{ mine: 'yes' }, 'mine'],
    [{ page: 1.5 }, 'page'], [{ page: '2' }, 'page'], [{ status: null }, 'status'], [{ mine: null }, 'mine'],
  ])('AC-6/7/8/9: rejects %j without querying', async (input, field) => {
    expect(await call(input)).toEqual({ content: [{ type: 'text', text: `invalid_input: ${field}` }], isError: true });
    expect(list).not.toHaveBeenCalled();
  });
  it('AC-10: logs unexpected failure without leaking details', async () => {
    const log = vi.spyOn(Logger.prototype, 'error'); log.mockClear();
    list.mockRejectedValue(new Error('db down'));
    expect(await call()).toEqual({ content: [{ type: 'text', text: 'error: koda_list_approvals failed' }], isError: true });
    expect(log).toHaveBeenCalled();
  });
});
