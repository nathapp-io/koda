import { Logger } from '@nestjs/common';
import { AssistantToolExecutor } from './assistant-tool.executor';
import { AssistantToolRegistry } from './assistant-tool.registry';
import { currentContext } from '../../action-context/action-context';

function setup(agent = false) {
  let inside = false;
  const order: string[] = [];
  const links = {
    lockThread: vi.fn(async () => { expect(inside).toBe(true); order.push('lock'); return true; }),
    countPendingInThread: vi.fn(async () => 0),
    findByRequest: vi.fn(async () => null),
    insert: vi.fn(async (link) => link),
  };
  const gate = { gate: vi.fn(async () => {
    expect(inside).toBe(true); order.push('gate');
    expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: agent ? 'AGENT' : 'USER', id: 'requester' }, origin: 'thread' });
    return { status: 'pending', request: { id: 'r1' } };
  }) };
  const resolver = { resolve: vi.fn(async () => { expect(inside).toBe(false); return { mode: 'human' }; }) };
  const bus = { publish: vi.fn(() => { expect(inside).toBe(false); }) };
  const tx = { run: vi.fn(async (fn) => { inside = true; try { return await fn(); } finally { inside = false; } }) };
  const tool = { descriptor: { name: 'koda_add_comment', description: '', inputSchema: {} }, key: 'comment.create', kind: 'write' as const, parse: (input: unknown) => input, preview: vi.fn(async () => 'preview'), execute: vi.fn(async () => 'written') };
  const registry = new AssistantToolRegistry(); registry.register(tool);
  const calls = { findByCall: vi.fn(async () => null), record: vi.fn(), findCallContext: vi.fn(async () => ({ project: { id: 'p', slug: 'web' }, threadId: 't', creator: agent ? { type: 'AGENT', id: 'requester', name: 'agent', status: 'ACTIVE', roles: [], capabilities: [] } : { id: 'requester', email: 'a@b.test', role: 'MEMBER', disabled: false } })) };
  const executor = new AssistantToolExecutor(registry, calls as never, { resolveMembership: vi.fn(async () => null) } as never, { can: vi.fn(async () => ({ allowed: true })) } as never, gate as never, resolver as never, links as never, bus as never, tx as never);
  const run = (toolCallId = 'c') => executor.execute({ jobId: 'j', toolCallId, name: tool.descriptor.name, input: { ref: 'WEB-1', body: 'hello' } });
  return { executor, run, links, gate, resolver, bus, tx, tool, order, isInside: () => inside };
}

describe('waiting thread approval gate', () => {
  afterEach(() => vi.restoreAllMocks());
  it('returns an executed gate result after a waiting-to-none policy change without fabricating a link', async () => {
    const s = setup();
    s.gate.gate.mockResolvedValue({ status: 'executed', result: { text: 'done' } } as never);
    expect(await s.run()).toEqual({ content: 'done', isError: false });
    expect(s.links.insert).not.toHaveBeenCalled();
    expect(s.bus.publish).not.toHaveBeenCalled();
  });
  it('AC-1–5,9: locks then gates in a transaction, links once and publishes after commit without executing', async () => {
    const s = setup();
    expect(await s.run()).toEqual({ content: 'pending r1: awaiting approval; do not retry', isError: false });
    expect(s.order).toEqual(['lock', 'gate']);
    expect(s.resolver.resolve).toHaveBeenCalledWith({ key: 'comment.create', projectId: 'p', subject: { type: 'ASSISTANT', id: 'assistant' } });
    expect(s.gate.gate).toHaveBeenCalledWith('comment.create', { projectId: 'p', threadId: 't', jobId: 'j', args: { ref: 'WEB-1', body: 'hello' } }, { projectId: 'p' });
    expect(s.links.insert).toHaveBeenCalledWith({ requestId: 'r1', threadId: 't', jobId: 'j', toolCallId: 'c', tool: 'koda_add_comment', preview: 'preview' });
    expect(s.bus.publish).toHaveBeenCalledTimes(1);
    expect(s.bus.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread', threadId: 't' }));
    expect(s.tool.execute).not.toHaveBeenCalled();
  });
  it.each(['self', 'agent'])('also waits when policy requires %s', async (mode) => {
    const s = setup(); s.resolver.resolve.mockResolvedValue({ mode } as never);
    expect((await s.run()).content).toBe('pending r1: awaiting approval; do not retry');
    expect(s.tool.execute).not.toHaveBeenCalled();
  });
  it('AC-6: checks the cap before even looking up a duplicate', async () => {
    const s = setup(); s.links.countPendingInThread.mockResolvedValue(10);
    expect(await s.run()).toEqual({ content: 'refused: 10 actions are pending in this thread; wait for the user to decide them', isError: true });
    expect(s.gate.gate).not.toHaveBeenCalled(); expect(s.links.insert).not.toHaveBeenCalled();
  });
  it('AC-7,11: a duplicate request answers its id without another link or frame', async () => {
    const s = setup(); s.links.findByRequest.mockResolvedValue({ requestId: 'r1' } as never);
    expect((await s.run('different')).content).toBe('pending r1: awaiting approval; do not retry');
    expect(s.links.insert).not.toHaveBeenCalled(); expect(s.bus.publish).not.toHaveBeenCalled();
  });
  it('AC-8: an agent requester also waits as the assistant', async () => {
    const s = setup(true); expect((await s.run()).content).toBe('pending r1: awaiting approval; do not retry'); expect(s.tool.execute).not.toHaveBeenCalled();
  });
  it('AC-10: a missing thread never reaches the gate', async () => {
    const s = setup(); s.links.lockThread.mockResolvedValue(false);
    expect(await s.run()).toEqual({ content: 'not_found', isError: true }); expect(s.gate.gate).not.toHaveBeenCalled();
  });
  it.each(['gate', 'transaction'])('AC-12,15: a %s failure is caught and its stack logged after leaving the transaction', async (where) => {
    const s = setup(); const error = new Error('broken');
    if (where === 'gate') s.gate.gate.mockRejectedValue(error); else s.tx.run.mockRejectedValue(error);
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => { expect(s.isInside()).toBe(false); }); log.mockClear();
    expect(await s.run()).toEqual({ content: 'error: koda_add_comment failed', isError: true });
    expect(log).toHaveBeenCalledWith(expect.any(String), error.stack); expect(s.bus.publish).not.toHaveBeenCalled();
  });
});
