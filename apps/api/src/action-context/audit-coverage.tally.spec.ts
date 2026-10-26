import { describe, expect, it } from 'vitest';
import {
  bookkeeping, noteAuditEntry, noteAuditWrite, openAuditScope, runInAuditScope,
  withTransactionTally,
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
});
