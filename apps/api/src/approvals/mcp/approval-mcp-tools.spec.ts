import { Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import { currentContext } from '../../action-context/action-context';
import { ApprovalRequestQueries } from '../approval-request.queries';
import { ApprovalDecisionService } from '../approval-decision.service';
import { ApprovalMcpTools } from './approval-mcp-tools';
import { ApprovalDecideForbiddenError, ApprovalRequestExpiredError, ApprovalRequestNotFoundError, ApprovalRequestNotPendingError } from '../domain/approval.errors';

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
    expect(registrations.map(({ name }) => name)).toEqual(['koda_list_approvals', 'koda_decide_approval']);
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

describe('ApprovalMcpTools decide (US-013)', () => {
  const list = vi.fn();
  const get = vi.fn();
  const decide = vi.fn();
  const tools = () => new ApprovalMcpTools({ list, get } as unknown as ApprovalRequestQueries, { decide } as unknown as ApprovalDecisionService);
  const registrations = () => tools().registrations(agent);
  const decisionTool = () => {
    const tool = registrations()[1];
    if (!tool) throw new Error('missing decide registration');
    return tool;
  };
  const call = (input: unknown) => decisionTool().handler(input);
  beforeEach(() => {
    list.mockReset(); get.mockReset(); decide.mockReset();
    get.mockResolvedValue({}); decide.mockResolvedValue({ id: 'r1', status: 'executed' });
  });
  it('AC-1: registers list then decide', () => expect(registrations().map(({ name }) => name)).toEqual(['koda_list_approvals', 'koda_decide_approval']));
  it('AC-6: advertises optional object params without changing required arguments', () => {
    expect(decisionTool().inputSchema).toMatchObject({
      properties: { params: { type: 'object' } }, required: ['id', 'decision'],
    });
  });
  it('AC-2/3/4: checks visibility then decides in MCP action context and answers status', async () => {
    decide.mockImplementation(async () => {
      const ctx = currentContext();
      expect({ actorType: ctx?.actor.type, actorId: ctx?.actor.id, origin: ctx?.origin }).toEqual({ actorType: 'AGENT', actorId: agent.id, origin: 'mcp' });
      return { id: 'r1', status: 'executed' };
    });
    expect(await call({ id: 'r1', decision: 'approve' })).toEqual({ content: [{ type: 'text', text: 'r1 executed' }], isError: false });
    expect(get).toHaveBeenCalledWith({ type: 'AGENT', id: agent.id }, 'r1');
    expect(decide).toHaveBeenCalledWith('r1', 'approve', null);
  });
  it('AC-8: forwards supplied decision params in the service params position', async () => {
    await call({ id: 'r1', decision: 'approve', params: { remember: true } });
    expect(decide).toHaveBeenCalledWith('r1', 'approve', null, undefined, { remember: true });
  });
  it.each([[], null, 'x', new Date(), undefined])('AC-9/10: rejects non-plain params %j before deciding', async (params) => {
    expect(await call({ id: 'r1', decision: 'approve', params })).toEqual({ content: [{ type: 'text', text: 'invalid_input: params' }], isError: true });
    expect(get).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
  });
  it.each([[{ id: 'r1', decision: 'maybe' }, 'decision'], [{ id: '', decision: 'approve' }, 'id'], [{ id: 'r1', decision: 'approve', comment: 'x'.repeat(2001) }, 'comment']])('AC-5/6/7/9 invalid input %j', async (input, field) => {
    expect(await call(input)).toEqual({ content: [{ type: 'text', text: `invalid_input: ${field}` }], isError: true });
    expect(get).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
  });
  it('rejects unknown arguments before querying or deciding', async () => {
    expect(await call({ id: 'r1', decision: 'approve', extra: true })).toEqual({ content: [{ type: 'text', text: 'invalid_input: extra' }], isError: true });
    expect(get).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
  });
  it('AC-8/9 missing request does not decide', async () => {
    get.mockRejectedValue(new ApprovalRequestNotFoundError('r1'));
    expect(await call({ id: 'r1', decision: 'approve' })).toEqual({ content: [{ type: 'text', text: 'not_found' }], isError: true });
    expect(decide).not.toHaveBeenCalled();
  });
  it.each([
    [new ApprovalDecideForbiddenError('tier-too-low'), 'forbidden: tier-too-low'],
    [new ApprovalRequestNotPendingError('rejected'), 'not_pending: rejected'],
    [new ApprovalRequestExpiredError('r1'), 'expired'],
    [new Error('boom'), 'error: koda_decide_approval failed'],
  ])('AC-10/11/12/13 maps error', async (error, text) => {
    decide.mockRejectedValue(error);
    const answer = await call({ id: 'r1', decision: 'reject' });
    expect(answer.content[0]?.text).toBe(text); expect(answer.isError).toBe(true);
  });
});
