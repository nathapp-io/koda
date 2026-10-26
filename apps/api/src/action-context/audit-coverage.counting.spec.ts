import { currentAuditScope, openAuditScope } from './audit-coverage';
import { runWithActor } from './action-context';
import { ContextlessWriteError, contextlessWriteHandler, type GuardedOperationParams } from './contextless-write';

describe('contextlessWriteHandler audit coverage counting', () => {
  const handler = contextlessWriteHandler('throw');
  const actor = { type: 'USER' as const, id: 'u1' };

  function runWrite(params: Omit<GuardedOperationParams, 'args'> & { args?: unknown }) {
    return runWithActor(actor, () => openAuditScope('POST /tickets', async (scope) => {
      const result = await handler({ ...params, args: params.args ?? {} });
      return { result, scope };
    }));
  }

  it('AC-1: counts a resolved model update inside an actor context and open scope', async () => {
    const { scope } = await runWrite({ model: 'Ticket', operation: 'update', query: async () => ({ id: 't1' }) });
    expect(scope.writes).toEqual(['Ticket.update']);
  });

  it('AC-2: counts deleteMany when rows were deleted', async () => {
    const { scope } = await runWrite({ model: 'Ticket', operation: 'deleteMany', query: async () => ({ count: 2 }) });
    expect(scope.writes).toEqual(['Ticket.deleteMany']);
  });

  it('AC-3: does not count updateMany or deleteMany with zero rows', async () => {
    for (const operation of ['updateMany', 'deleteMany'] as const) {
      const { scope } = await runWrite({ model: 'Ticket', operation, query: async () => ({ count: 0 }) });
      expect(scope.writes).toEqual([]);
    }
  });

  it('AC-4: counts createManyAndReturn only when it returns rows', async () => {
    const empty = await runWrite({ model: 'TicketLink', operation: 'createManyAndReturn', query: async () => [] });
    expect(empty.scope.writes).toEqual([]);
    const one = await runWrite({ model: 'TicketLink', operation: 'createManyAndReturn', query: async () => [{ id: 'l1' }] });
    expect(one.scope.writes).toEqual(['TicketLink.createManyAndReturn']);
  });

  it('AC-5: counts raw executes only when the affected row count is positive', async () => {
    const positive = await runWrite({ operation: '$executeRaw', query: async () => 1 });
    expect(positive.scope.writes).toEqual(['$executeRaw']);
    const zero = await runWrite({ operation: '$executeRaw', query: async () => 0 });
    expect(zero.scope.writes).toEqual([]);
  });

  it('AC-6: does not count AuditEntry writes', async () => {
    const { scope } = await runWrite({ model: 'AuditEntry', operation: 'create', query: async () => ({ id: 'a1' }) });
    expect(scope.writes).toEqual([]);
  });

  it('AC-7: does not count a rejected query and propagates its error unchanged', async () => {
    const failure = new Error('write failed');
    const outcome = runWithActor(actor, () => openAuditScope('POST /tickets', async (scope) => {
      await expect(handler({ model: 'Ticket', operation: 'update', args: {}, query: () => Promise.reject(failure) })).rejects.toBe(failure);
      return scope;
    }));
    await expect(outcome).resolves.toMatchObject({ writes: [] });
  });

  it('AC-8: returns the exact query result for a counted write', async () => {
    const result = { id: 't1', updated: true };
    await expect(runWithActor(actor, () => openAuditScope('POST /tickets', async () =>
      handler({ model: 'Ticket', operation: 'update', args: {}, query: async () => result }),
    ))).resolves.toBe(result);
  });

  it('AC-9: preserves the context-less throw path without running the query', async () => {
    const query = vi.fn(async () => ({ id: 't1' }));
    const write = handler({ model: 'Ticket', operation: 'update', args: {}, query });
    await expect(write).rejects.toBeInstanceOf(ContextlessWriteError);
    await expect(write).rejects.toMatchObject({
      operation: 'update', model: 'Ticket',
    });
    expect(query).not.toHaveBeenCalled();
    expect(currentAuditScope()).toBeUndefined();
  });
});
