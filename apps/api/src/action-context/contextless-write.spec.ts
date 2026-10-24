import { Logger } from '@nestjs/common';
import { currentContext, runWithActor } from './action-context';
import {
  ContextlessWriteError,
  contextlessWriteHandler,
  GUARDED_OPERATIONS,
  resolveWriteGuardMode,
} from './contextless-write';

describe('resolveWriteGuardMode', () => {
  it.each([
    [{ NODE_ENV: 'production' }, 'record'],
    [{ ENV_NAME: 'production', NODE_ENV: 'development' }, 'record'],
    [{ NODE_ENV: 'test' }, 'throw'],
    [{}, 'throw'],
  ] as const)('resolves %j to %s', (env, mode) => {
    expect(resolveWriteGuardMode(env)).toBe(mode);
  });
});

describe('GUARDED_OPERATIONS', () => {
  it('contains exactly model writes and raw execute operations', () => {
    expect(GUARDED_OPERATIONS).toEqual(new Set([
      'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany',
      'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', '$executeRaw', '$executeRawUnsafe',
    ]));
  });
});

describe('contextlessWriteHandler', () => {
  const handler = contextlessWriteHandler('throw');

  it('rejects context-less writes with a descriptive error without querying', async () => {
    const query = vi.fn(async () => 'written');
    const args = { data: { name: 'A' } };

    const write = handler({ model: 'User', operation: 'create', args, query });
    await expect(write).rejects.toBeInstanceOf(ContextlessWriteError);
    await expect(write).rejects.toMatchObject({
      operation: 'create',
      model: 'User',
      message: 'write outside an action context: User.create',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('uses only the operation name for raw writes without a model', async () => {
    await expect(handler({ operation: '$executeRaw', args: {}, query: async () => undefined })).rejects.toThrow(
      'write outside an action context: $executeRaw',
    );
  });

  it('passes reads through', async () => {
    const query = vi.fn(async (args: unknown) => args);
    await expect(handler({ model: 'User', operation: 'findMany', args: { take: 1 }, query })).resolves.toEqual({ take: 1 });
  });

  it('passes in-context writes through', async () => {
    const query = vi.fn(async () => 'updated');
    await expect(runWithActor({ type: 'USER', id: 'u1' }, () =>
      handler({ model: 'User', operation: 'update', args: {}, query }),
    )).resolves.toBe('updated');
  });

  it('propagates the exact query rejection for an in-context write', async () => {
    const failure = new Error('db failed');
    await expect(runWithActor({ type: 'USER', id: 'u1' }, () => handler({
      model: 'User', operation: 'update', args: {}, query: () => Promise.reject(failure),
    }))).rejects.toBe(failure);
  });

  it('runs the lazy query thenable in the unknown system context and logs the violation', async () => {
    // `test-setup.ts` silences `Logger.prototype.error` for the whole run; this asserts on that very
    // spy, so it is never restored — restoring would unsilence the Nest logger for every later test
    // in this file. The silencing implementation is re-applied in `finally`, so it survives a failing
    // assertion too.
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    logger.mockClear();

    try {
      let actor: unknown;
      const query = vi.fn(() => ({
        then(resolve: (value: string) => void) {
          actor = currentContext()?.actor;
          resolve('created');
        },
      }));

      await expect(contextlessWriteHandler('record')({ model: 'User', operation: 'create', args: {}, query }))
        .resolves.toBe('created');
      expect(actor).toEqual({ type: 'SYSTEM', id: 'unknown' });
      expect(logger).toHaveBeenCalledWith('write outside an action context: User.create');
    } finally {
      logger.mockClear();
      logger.mockImplementation(() => undefined);
    }
  });

  it('returns the record-mode query result', async () => {
    await expect(contextlessWriteHandler('record')({
      model: 'User', operation: 'create', args: {}, query: async () => 42,
    })).resolves.toBe(42);
  });

  it('exposes the dedicated error type', () => {
    expect(new ContextlessWriteError('create', 'User')).toBeInstanceOf(Error);
  });
});
