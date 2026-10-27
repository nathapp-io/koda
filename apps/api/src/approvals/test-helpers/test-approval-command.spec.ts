import { configurableTestCommand } from './test-approval-command';

/**
 * P3 approval core (US-007). The reusable command a spec registers under an approvable key, so the
 * gate, decision and execution cases can make it parse, fail, write, audit and run on demand.
 */
describe('configurableTestCommand', () => {
  it('AC-9: parseThrowsAfter 1 lets the first parse through, fails the second, and reset() clears it', () => {
    const { command, state, reset } = configurableTestCommand('label.delete');
    state.parseThrowsAfter = 1;

    expect(command.parse({ labelId: 'l1' })).toEqual({ labelId: 'l1' });
    expect(() => command.parse({ labelId: 'l1' })).toThrow(TypeError);
    expect(() => command.parse({ labelId: 'l1' })).toThrow('test parse refused');

    reset();

    expect(command.parse({ labelId: 'l1' })).toEqual({ labelId: 'l1' });
    expect(state.calls).toEqual([]);
  });

  it('parses an object of string values into a copy, and refuses anything else', async () => {
    const { command } = configurableTestCommand('label.delete');
    const input = { labelId: 'l1' };

    const parsed = command.parse(input);
    expect(parsed).toEqual({ labelId: 'l1' });
    expect(parsed).not.toBe(input);
    expect(await command.execute(parsed)).toBe('done');
    expect(() => command.parse({ labelId: 1 })).toThrow(TypeError);
    expect(() => command.parse(['l1'])).toThrow(TypeError);
    expect(() => command.parse(null)).toThrow(TypeError);
  });

  it('records every executed input on state.calls and returns done', async () => {
    const { command, state } = configurableTestCommand('label.delete');

    expect(await command.execute({ labelId: 'l1' })).toBe('done');
    expect(await command.execute({ labelId: 'l2' })).toBe('done');

    expect(state.calls).toEqual([{ labelId: 'l1' }, { labelId: 'l2' }]);
  });

  it('records the decision each execute received, aligned with the recorded calls', async () => {
    const { command, state } = configurableTestCommand('label.delete');

    await command.execute({ labelId: 'l1' });
    await command.execute({ labelId: 'l2' }, { remember: true });

    expect(state.decisions).toEqual([undefined, { remember: true }]);
    expect(state.calls).toHaveLength(state.decisions.length);
  });

  it('honours parseThrows and parseReturnsUndefined', () => {
    const { command, state } = configurableTestCommand('label.delete');

    state.parseReturnsUndefined = true;
    expect(command.parse({ labelId: 'l1' })).toBeUndefined();

    state.parseReturnsUndefined = false;
    state.parseThrows = true;
    expect(() => command.parse({ labelId: 'l1' })).toThrow(TypeError);
  });

  it('throws after its other effects when executeThrows is set', async () => {
    const { command, state } = configurableTestCommand('label.delete');
    state.executeThrows = true;

    await expect(command.execute({ labelId: 'l1' })).rejects.toThrow('boom');
    expect(state.calls).toEqual([{ labelId: 'l1' }]);
    expect(await command.execute({ labelId: 'l2' }).catch((error: Error) => error.message)).toBe('boom');
  });

  it('writes the configured Label row through Prisma before the rest', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'label-1' });
    const { command, state } = configurableTestCommand('label.delete', { prisma: { client: { label: { create } } } });
    state.writeLabel = { projectId: 'p1', name: 'bug' };

    await command.execute({ labelId: 'l1' });

    expect(create).toHaveBeenCalledExactlyOnceWith({ data: { projectId: 'p1', name: 'bug' } });
  });

  it('records the audit entry with its own key when recordAudit is set', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const { command, state } = configurableTestCommand('label.delete', { audit: { record } });
    state.recordAudit = true;

    await command.execute({ labelId: 'l1' });

    expect(record).toHaveBeenCalledExactlyOnceWith({ key: 'label.delete', resourceType: 'test', resourceId: 'test' });
  });

  it('uses toResult when set and leaves it undefined otherwise', () => {
    const { command, state } = configurableTestCommand('label.delete');
    expect(command.toResult).toBeUndefined();

    state.toResult = (result: string) => ({ deleted: result === 'done' ? 1 : 0 });
    expect(command.toResult?.('done')).toEqual({ deleted: 1 });
  });

  it('carries parseDecision only while a case asks for one, recording each call and its answer', () => {
    const { command, state } = configurableTestCommand('label.delete');
    expect(command.parseDecision).toBeUndefined();

    state.parseDecision = { calls: [], result: { remember: true }, throws: false };
    expect(command.parseDecision?.('approve', { remember: true }, { labelId: 'l1' })).toEqual({ remember: true });
    expect(state.parseDecision.calls).toEqual([{ decision: 'approve', params: { remember: true }, input: { labelId: 'l1' } }]);

    state.parseDecision.throws = true;
    expect(() => command.parseDecision?.('reject', undefined, { labelId: 'l1' })).toThrow('test parse refused');

    state.parseDecision = null;
    expect(command.parseDecision).toBeUndefined();
  });

  it('carries onReject only while a case asks for one, recording each call and throwing when set', async () => {
    const { command, state } = configurableTestCommand('label.delete');
    expect(command.onReject).toBeUndefined();

    state.onReject = { calls: [], throws: null };
    await command.onReject?.({ labelId: 'l1' }, { choice: 'deny' });
    expect(state.onReject.calls).toEqual([{ input: { labelId: 'l1' }, decision: { choice: 'deny' } }]);

    const failure = new Error('reject refused');
    state.onReject.throws = failure;
    await expect(command.onReject?.({ labelId: 'l1' }, undefined)).rejects.toBe(failure);
    expect(state.onReject.calls).toHaveLength(2);

    state.onReject = null;
    expect(command.onReject).toBeUndefined();
  });

  it('carries afterCommit only while a case asks for one, recording each call and throwing when set', async () => {
    const { command, state } = configurableTestCommand('label.delete');
    expect(command.afterCommit).toBeUndefined();

    state.afterCommit = { calls: [], throws: null };
    await command.afterCommit?.({ labelId: 'l1' }, { remember: true }, 'done');
    expect(state.afterCommit.calls).toEqual([{ input: { labelId: 'l1' }, decision: { remember: true }, result: 'done' }]);

    const failure = new Error('after-commit refused');
    state.afterCommit.throws = failure;
    await expect(command.afterCommit?.({ labelId: 'l1' }, undefined, 'done')).rejects.toBe(failure);
    expect(state.afterCommit.calls).toHaveLength(2);

    state.afterCommit = null;
    expect(command.afterCommit).toBeUndefined();
  });

  it('turns every state field off on reset()', () => {
    const { state, reset } = configurableTestCommand('label.delete');
    Object.assign(state, {
      parseThrows: true,
      parseThrowsAfter: 2,
      parseReturnsUndefined: true,
      executeThrows: true,
      writeLabel: { projectId: 'p1', name: 'bug' },
      recordAudit: true,
      toResult: () => null,
      parseDecision: { calls: [], result: 'ok', throws: false },
      onReject: { calls: [], throws: null },
      afterCommit: { calls: [], throws: null },
    });

    reset();

    expect(state).toEqual({
      calls: [],
      decisions: [],
      parseThrows: false,
      parseThrowsAfter: null,
      parseReturnsUndefined: false,
      executeThrows: false,
      writeLabel: null,
      recordAudit: false,
      toResult: null,
      parseDecision: null,
      onReject: null,
      afterCommit: null,
    });
  });

  it('names the missing dependency instead of failing obscurely', async () => {
    const { command, state } = configurableTestCommand('label.delete');
    state.writeLabel = { projectId: 'p1', name: 'bug' };

    await expect(command.execute({ labelId: 'l1' })).rejects.toThrow('needs a prisma dependency');
  });
});
