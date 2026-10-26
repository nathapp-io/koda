import { Logger } from '@nestjs/common';
import { restoreEnvAfterEach } from '../common/test-helpers/restore-env';
import {
  UnauditedWriteError,
  currentAuditScope,
  noteAuditEntry,
  noteAuditWrite,
  runInAuditScope,
  type AuditScope,
} from './audit-coverage';

/**
 * US-001 — the inert entry-point audit scope core. Every case runs `runInAuditScope`, the only
 * checking entry point this story adds: the scope passes when it wrote nothing it counts or
 * recorded at least one entry, and fails when it wrote and recorded nothing.
 */

/** The UnauditedWriteError a scope rejects with; fails the test when it rejects with anything else. */
async function rejectedWithUnauditedWrite(promise: Promise<unknown>): Promise<UnauditedWriteError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnauditedWriteError) return error;
    throw error;
  }

  throw new Error('expected the scope to reject, but it resolved');
}

/** `test-setup.ts` no-ops `Logger.prototype.error` for the whole run; assert on that same spy, cleared. */
function errorLogger(): ReturnType<typeof vi.spyOn> {
  const logger = vi.spyOn(Logger.prototype, 'error');
  logger.mockClear();
  return logger;
}

describe('audit coverage scopes', () => {
  restoreEnvAfterEach();

  // Every AC but AC-5/AC-6 runs in the guard's `throw` mode; `.env.test` sets no `ENV_NAME`, and
  // `restoreEnvAfterEach` puts back whatever the run inherited.
  beforeEach(() => {
    delete process.env['ENV_NAME'];
  });

  it('AC-1: rejects with UnauditedWriteError when the scope wrote and recorded nothing', async () => {
    const scope = runInAuditScope('POST /x', async () => {
      noteAuditWrite('Ticket.update');
    });

    await expect(scope).rejects.toBeInstanceOf(UnauditedWriteError);
  });

  it('AC-2: names the surface and every write label', async () => {
    const error = await rejectedWithUnauditedWrite(
      runInAuditScope('POST /x', async () => {
        noteAuditWrite('Ticket.update');
      }),
    );

    expect(error.surface).toBe('POST /x');
    expect(error.writes).toEqual(['Ticket.update']);
  });

  it('AC-3: carries the guard message', async () => {
    const error = await rejectedWithUnauditedWrite(
      runInAuditScope('POST /x', async () => {
        noteAuditWrite('Ticket.update');
      }),
    );

    expect(error.message).toBe('unaudited write: POST /x wrote Ticket.update and recorded no audit entry');
  });

  it('AC-4: resolves the work result when the scope recorded an entry', async () => {
    const scope = runInAuditScope('POST /x', async () => {
      noteAuditWrite('Ticket.update');
      noteAuditEntry();
      return 42;
    });

    await expect(scope).resolves.toBe(42);
  });

  it('AC-5: resolves the work result in production mode', async () => {
    process.env['ENV_NAME'] = 'production';

    const scope = runInAuditScope('POST /x', async () => {
      noteAuditWrite('Ticket.update');
      return 42;
    });

    await expect(scope).resolves.toBe(42);
  });

  it('AC-6: logs the violation once in production mode', async () => {
    process.env['ENV_NAME'] = 'production';
    const logger = errorLogger();

    const scope = runInAuditScope('POST /x', async () => {
      noteAuditWrite('Ticket.update');
      return 42;
    });

    await expect(scope).resolves.toBe(42);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0]).toEqual([
      'unaudited write: POST /x wrote Ticket.update and recorded no audit entry',
    ]);
  });

  it('AC-7: propagates the work rejection unchanged', async () => {
    const failure = new Error('db failed');

    const scope = runInAuditScope('POST /x', async () => {
      noteAuditWrite('Ticket.update');
      throw failure;
    });

    await expect(scope).rejects.toBe(failure);
  });

  it('AC-8: passes an allowlisted surface without logging', async () => {
    const logger = errorLogger();

    const scope = runInAuditScope('system:unknown', async () => {
      noteAuditWrite('Contract.update');
      return 'result';
    });

    await expect(scope).resolves.toBe('result');
    expect(logger).not.toHaveBeenCalled();
  });

  it('AC-9: propagates a synchronous throw unchanged', () => {
    const failure = new Error('sync boom');
    let caught: unknown;

    try {
      runInAuditScope('POST /x', () => {
        noteAuditWrite('Ticket.update');
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
  });

  it('AC-10: counts an entry recorded in a nested scope in the enclosing scope', async () => {
    const outer = runInAuditScope('writer:Ticker', async () => {
      noteAuditWrite('Schedule.update');
      await runInAuditScope('system:schedule', async () => {
        noteAuditEntry();
      });
    });

    await expect(outer).resolves.toBeUndefined();
  });

  it('AC-11: fails the nested scope that wrote, and leaves the enclosing scope clean', async () => {
    let outerScope: AuditScope | undefined;

    const outer = runInAuditScope('writer:Ticker', async () => {
      outerScope = currentAuditScope();
      await runInAuditScope('system:vcs', async () => {
        noteAuditWrite('TicketLink.update');
      });
    });

    const error = await rejectedWithUnauditedWrite(outer);
    expect(error.surface).toBe('system:vcs');
    expect(outerScope?.writes).toEqual([]);
  });

  it('AC-12: a detached scope cannot satisfy the scope that started it', async () => {
    const outer = runInAuditScope('writer:Sweeper', async () => {
      noteAuditWrite('Session.deleteMany');
      await runInAuditScope('task:T', async () => {
        noteAuditEntry();
      }, { detached: true });
    });

    const error = await rejectedWithUnauditedWrite(outer);
    expect(error.surface).toBe('writer:Sweeper');
  });

  it('AC-13: notes outside any scope are no-ops', () => {
    expect(currentAuditScope()).toBeUndefined();
    expect(() => noteAuditWrite('Ticket.update')).not.toThrow();
    expect(() => noteAuditEntry()).not.toThrow();
    expect(currentAuditScope()).toBeUndefined();
  });

  // Not an AC: the synchronous branch of `runInAuditScope` (check at once, value returned as it is,
  // not a promise), which no AC's scenario reaches — every AC but AC-9 and AC-13 returns a promise.
  it('checks a synchronous result at once and returns it unchanged', () => {
    expect(runInAuditScope('system:unknown', () => 7)).toBe(7);

    expect(() =>
      runInAuditScope('POST /x', () => {
        noteAuditWrite('Ticket.update');
        return 7;
      }),
    ).toThrow(UnauditedWriteError);
  });
});
