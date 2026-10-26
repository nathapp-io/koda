import { describe, expect, it } from 'vitest';
import {
  UnauditedWriteError, bookkeeping, currentAuditScope, noteAuditEntry, noteAuditWrite, openAuditScope,
  runInAuditScope, withTransactionTally, type AuditScope,
} from './audit-coverage';

describe('withTransactionTally', () => {
  it('AC-1: buffers writes until callback fulfilment and preserves its result', async () => {
    await openAuditScope('POST /x', async (scope) => {
      const result = await withTransactionTally(async () => {
        noteAuditWrite('Label.create');
        await Promise.resolve();
        expect(scope.writes).toEqual([]);
        return 42;
      });
      expect(result).toBe(42);
      expect(scope.writes).toEqual(['Label.create']);
    });
  });

  it('AC-2: drops writes on rejection and preserves the error', async () => {
    const failure = new Error('rollback');
    await openAuditScope('POST /x', async (scope) => {
      await expect(withTransactionTally(async () => {
        noteAuditWrite('Label.create');
        throw failure;
      })).rejects.toBe(failure);
      expect(scope.writes).toEqual([]);
    });
  });

  it('AC-3: drops entries on rejection', async () => {
    const failure = new Error('rollback');
    await openAuditScope('POST /x', async (scope) => {
      await expect(withTransactionTally(async () => {
        noteAuditEntry();
        throw failure;
      })).rejects.toBe(failure);
      expect(scope.entries).toBe(0);
    });
  });

  it('AC-4: flushes entries to the captured nested scope and its parents', async () => {
    await openAuditScope('POST /x', async (outer) => {
      await openAuditScope('system:schedule', async (inner) => {
        await withTransactionTally(async () => {
          noteAuditEntry();
          expect(inner.entries).toBe(0);
          expect(outer.entries).toBe(0);
        });
        expect(inner.entries).toBe(1);
        expect(outer.entries).toBe(1);
      });
    });
  });

  it('AC-8: a scope opened and checked inside the callback defers its work to the captured scope', async () => {
    await openAuditScope('POST /x', async (scope) => {
      await withTransactionTally(async () => {
        await expect(runInAuditScope('system:vcs', async () => {
          noteAuditWrite('Label.create');
          return 42;
        })).resolves.toBe(42);
        expect(scope.writes).toEqual([]);
      });
      expect(scope.writes).toEqual(['Label.create']);
    });
  });

  it('keeps a fulfilled inner tally buffered until the outer tally succeeds', async () => {
    await openAuditScope('POST /x', async (scope) => {
      await withTransactionTally(async () => {
        noteAuditWrite('Label.create');
        await withTransactionTally(async () => {
          noteAuditWrite('Label.update');
          noteAuditEntry();
        });
        expect(scope.writes).toEqual([]);
        expect(scope.entries).toBe(0);
      });
      expect(scope.writes).toEqual(['Label.create', 'Label.update']);
      expect(scope.entries).toBe(1);
    });
  });

  it('drops fulfilled inner work when the outer tally rejects', async () => {
    const failure = new Error('outer rollback');
    await openAuditScope('POST /x', async (scope) => {
      await expect(withTransactionTally(async () => {
        await withTransactionTally(async () => {
          noteAuditWrite('Label.create');
          noteAuditEntry();
        });
        throw failure;
      })).rejects.toBe(failure);
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(0);
    });
  });

  it('keeps bookkeeping writes uncounted while still buffering entries', async () => {
    await openAuditScope('POST /x', async (scope) => {
      await withTransactionTally(() => bookkeeping('runner.heartbeat', async () => {
        noteAuditWrite('Runner.update');
        noteAuditEntry();
      }));
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(1);
    });
  });

  it('flushes to no scope if none was captured, even when the callback opens a scope', async () => {
    await expect(withTransactionTally(async () => {
      await runInAuditScope('system:vcs', async () => {
        noteAuditWrite('Label.create');
      });
      return 42;
    })).resolves.toBe(42);
  });

  // Review B1 — a detached scope keeps its own tally: nothing it records or writes may travel into
  // the entry point whose transaction merely encloses it.
  it('keeps a detached scope entry out of the enclosing scope, inside its transaction', async () => {
    const outer = runInAuditScope('writer:Sweeper', async () => {
      noteAuditWrite('Session.deleteMany');
      await withTransactionTally(async () => {
        await runInAuditScope('task:T', async () => {
          noteAuditEntry();
        }, { detached: true });
      });
    });

    const error = await outer.then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnauditedWriteError);
    expect((error as UnauditedWriteError).surface).toBe('writer:Sweeper');
  });

  it('counts a detached scope write in that scope, not in the enclosing one', async () => {
    let outerWrites: readonly string[] = [];

    await openAuditScope('writer:Sweeper', async (outer) => {
      noteAuditWrite('Session.deleteMany');
      await withTransactionTally(async () => {
        await expect(runInAuditScope('task:T', async () => {
          noteAuditWrite('TicketLink.update');
        }, { detached: true })).rejects.toBeInstanceOf(UnauditedWriteError);
      });

      noteAuditEntry();
      outerWrites = outer.writes;
    });

    expect(outerWrites).toEqual(['Session.deleteMany']);
  });

  // Review B1 (follow-up) — a detached boundary keeps its own outcome even inside a transaction that
  // has no entry point above it: the scope-less tally must not swallow the detached write, or the
  // detached scope passes with its write discarded.
  it('checks a detached scope opened inside a scope-less transaction', async () => {
    let detachedError: unknown;

    await expect(withTransactionTally(async () => {
      await runInAuditScope('task:T', async () => {
        noteAuditWrite('TicketLink.update');
      }, { detached: true }).catch((error: unknown) => { detachedError = error; });
    })).resolves.toBeUndefined();

    expect(detachedError).toBeInstanceOf(UnauditedWriteError);
    expect((detachedError as UnauditedWriteError).surface).toBe('task:T');
    expect((detachedError as UnauditedWriteError).writes).toEqual(['TicketLink.update']);
  });

  it('counts the transaction a detached scope opens in that scope under a scope-less transaction', async () => {
    await expect(withTransactionTally(async () => {
      await expect(runInAuditScope('task:T', async () => {
        await withTransactionTally(async () => {
          noteAuditWrite('TicketLink.update');
        });
      }, { detached: true })).rejects.toBeInstanceOf(UnauditedWriteError);
    })).resolves.toBeUndefined();
  });

  // Review B3 — an ordinary scope opened inside a scope-less transaction is still enclosed by that
  // transaction, so its nested transaction's work defers to the enclosing callback (US-004 AC-8)
  // instead of being counted in the scope that is already settling.
  it('defers a nested-scope write through a nested tally to the scope-less enclosing transaction', async () => {
    await expect(withTransactionTally(async () => {
      await expect(runInAuditScope('system:vcs', async () => {
        await withTransactionTally(async () => {
          noteAuditWrite('Label.create');
        });
      })).resolves.toBeUndefined();
    })).resolves.toBeUndefined();
  });

  it('defers a nested-scope write through a nested tally to the enclosing entry point', async () => {
    await openAuditScope('POST /x', async (scope) => {
      await withTransactionTally(async () => {
        await expect(runInAuditScope('system:vcs', async () => {
          await withTransactionTally(async () => {
            noteAuditWrite('Label.create');
          });
        })).resolves.toBeUndefined();
        expect(scope.writes).toEqual([]);
      });

      expect(scope.writes).toEqual(['Label.create']);
    });
  });

  // Review B2 (follow-up) — a nested transaction that settles after the scope that opened it settled
  // and was checked is dropped, even when an enclosing transaction could absorb its entry: otherwise
  // the enclosing entry point passes on an entry it never recorded.
  it('drops a tally that settles after its scope closed instead of merging into the enclosing tally', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let late!: Promise<void>;

    const outer = runInAuditScope('writer:Sweeper', async () => {
      noteAuditWrite('Session.deleteMany');
      await withTransactionTally(async () => {
        await runInAuditScope('system:child', async () => {
          // Started but not awaited: it outlives the child scope that opened it.
          late = withTransactionTally(async () => {
            noteAuditEntry();
            await gate;
          });
        });
        release();
        await late;
      });
    });

    const error = await outer.then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnauditedWriteError);
    expect((error as UnauditedWriteError).surface).toBe('writer:Sweeper');
  });

  // Review B2 — a transaction that outlives the scope that opened it counts nothing: the entry point
  // already settled and was checked.
  it('drops a fulfilled tally whose scope settled first', async () => {
    let scope: AuditScope | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let flushed!: Promise<void>;

    await runInAuditScope('system:unknown', async () => {
      scope = currentAuditScope();
      flushed = withTransactionTally(async () => {
        noteAuditWrite('Label.create');
        await gate;
      });
    });

    release();
    await flushed;

    expect(scope?.writes).toEqual([]);
  });
});
