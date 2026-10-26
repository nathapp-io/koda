import { ApprovalGate } from './approval-gate.service';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { UnregisteredApprovalCommandError } from './domain/approval.errors';
import type { ResolvedApproval } from './approval-policy.resolver';
import { configurableTestCommand } from './test-helpers/test-approval-command';
import { currentContext, runWithActionContext, type ActionActor, type ActionApproval } from '../action-context/action-context';

const input = { labelId: 'l1' };
const opts = { projectId: 'p1' };

describe('ApprovalGate', () => {
  let registry: ApprovalCommandRegistry;
  let testCommand: ReturnType<typeof configurableTestCommand>;
  let resolve: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<ResolvedApproval>>>;
  let requests: { create: ReturnType<typeof vi.fn> };
  let gate: ApprovalGate;
  const asActor = <T>(actor: ActionActor, fn: () => T) => runWithActionContext({ actor, origin: 'rest' }, fn);
  const agent = <T>(fn: () => T) => asActor({ type: 'AGENT', id: 'a1' }, fn);

  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
    testCommand = configurableTestCommand('label.delete');
    registry.register(testCommand.command);
    resolve = vi.fn().mockResolvedValue({ mode: 'none', floor: 'none', policy: null, source: 'default' });
    requests = { create: vi.fn() };
    gate = new ApprovalGate(registry, { resolve }, requests);
  });
  afterEach(() => {
    expect(requests.create).not.toHaveBeenCalled();
  });
  const untouched = () => {
    expect(resolve).not.toHaveBeenCalled();
    expect(testCommand.state.calls).toEqual([]);
  };
  it('AC-1: refuses an unregistered key before checking context', async () => {
    gate = new ApprovalGate(new ApprovalCommandRegistry(), { resolve }, requests);
    await expect(gate.gate('label.delete', input, opts)).rejects.toEqual(new UnregisteredApprovalCommandError('label.delete'));
    untouched();
  });
  it('AC-2: requires an action context before parsing', async () => {
    testCommand.state.parseThrows = true;
    await expect(gate.gate('label.delete', input, opts)).rejects.toThrow('approval gate needs an action context');
    untouched();
  });
  it.each([
    ['AC-3', { type: 'RUNNER', id: 'r1' }],
    ['AC-11', { type: 'SYSTEM', id: 'assistant' }],
    ['AC-13', { type: 'SYSTEM', id: 'approval' }],
  ] as const)('%s: refuses unsupported actors before parsing', async (_ac, actor) => {
    testCommand.state.parseThrows = true;
    await expect(asActor(actor, () => gate.gate('label.delete', input, opts))).rejects.toThrow(`approval gate cannot gate actor ${actor.type}/${actor.id}`);
    untouched();
  });
  it.each([
    [{ type: 'USER', id: 'u1' }, { type: 'USER', id: 'u1' }],
    [{ type: 'AGENT', id: 'a1' }, { type: 'AGENT', id: 'a1' }],
  ] as const)('derives the resolver subject from %j', async (actor, subject) => {
    await asActor(actor, () => gate.gate('label.delete', input, opts));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', projectId: 'p1', subject });
  });
  it('AC-4: resolves the assistant rather than its on-behalf-of principal', async () => {
    await runWithActionContext({ actor: { type: 'SYSTEM', id: 'assistant' }, onBehalfOf: { type: 'USER', id: 'u9' }, origin: 'thread' }, () => gate.gate('label.delete', input, opts));
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', projectId: 'p1', subject: { type: 'ASSISTANT', id: 'assistant' } });
  });
  it('AC-8: requires project scope before resolution', async () => {
    await expect(agent(() => gate.gate('label.delete', input, { projectId: null }))).rejects.toThrow('approval gate needs a project for key label.delete');
    untouched();
  });
  it.each([['AC-10', undefined], ['AC-12', null]] as const)('%s: refuses absent parsed input before scope checking', async (_ac, value) => {
    vi.spyOn(testCommand.command, 'parse').mockReturnValue(value as unknown as Record<string, string>);
    await expect(agent(() => gate.gate('label.delete', input, { projectId: null }))).rejects.toThrow('approval command parse returned no input: label.delete');
    untouched();
  });
  it('propagates parse errors without resolving or executing', async () => {
    const error = new TypeError('bad input');
    vi.spyOn(testCommand.command, 'parse').mockImplementation(() => { throw error; });
    await expect(agent(() => gate.gate('label.delete', input, opts))).rejects.toBe(error);
    untouched();
  });
  it.each([
    ['AC-5', 'USER', 'agent', { requiredMode: 'agent', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
    ['AC-6', 'AGENT', 'none', { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-7', 'USER', 'none', { requiredMode: 'none', satisfiedBy: 'none' }],
    ['AC-9', 'USER', 'human', { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u1' }],
  ] as const)('%s: runs now with scoped approval and restores the outer context', async (_ac, type, mode, approval) => {
    resolve.mockResolvedValue({ mode, floor: 'none', policy: null, source: 'default' });
    let executionApproval: ActionApproval | undefined;
    const execute = testCommand.command.execute;
    vi.spyOn(testCommand.command, 'execute').mockImplementation(async (parsed) => {
      await Promise.resolve();
      executionApproval = currentContext()?.approval;
      expect(currentContext()).toMatchObject({ actor: { type, id: type === 'USER' ? 'u1' : 'a1' }, origin: 'rest', correlationId: 'correlation' });
      return execute(parsed);
    });
    await runWithActionContext({ actor: { type, id: type === 'USER' ? 'u1' : 'a1' }, origin: 'rest', correlationId: 'correlation' }, async () => {
      const outer = currentContext();
      expect(await gate.gate('label.delete', input, opts)).toEqual({ status: 'executed', result: 'done', approval });
      expect(currentContext()).toBe(outer);
    });
    expect(executionApproval).toEqual(approval);
    expect(testCommand.state.calls).toEqual([input]);
  });
});
