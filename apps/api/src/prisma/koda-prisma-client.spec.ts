import { describe, expect, it, vi } from 'vitest';
import { noteAuditEntry, noteAuditWrite, openAuditScope } from '../action-context/audit-coverage';
import { KodaPrismaClient } from './koda-prisma-client';
import { createPgAdapter } from './pg-adapter';

const extensionClient = vi.hoisted(() => ({ current: {} as object }));
vi.mock('../generated/prisma/client', () => ({
  Prisma: { defineExtension: (extension: unknown) => extension },
  PrismaClient: class {
    $extends() { return extensionClient.current; }
  },
}));

// Exercise the real constructor wrapper over a controlled extended client, without a database.
function clientWithExtended(extended: object): KodaPrismaClient {
  extensionClient.current = extended;
  return new KodaPrismaClient({ adapter: createPgAdapter('postgresql://localhost/koda_test') });
}

describe('KodaPrismaClient transaction tally', () => {
  it('AC-9: delegates array transactions with original arguments and result unchanged', () => {
    const result = Promise.resolve([42]);
    const delegate = vi.fn((_input: unknown, _options?: unknown) => result);
    const model = {};
    const extended = { $transaction: delegate, label: model };
    const client = clientWithExtended(extended);
    const queries = [Promise.resolve(42)] as never[];
    const options = { isolationLevel: 'Serializable' as const };
    expect(client.$transaction(queries, options)).toBe(result);
    expect(delegate).toHaveBeenCalledExactlyOnceWith(queries, options);
    expect(delegate.mock.calls[0][0]).toBe(queries);
    expect(delegate.mock.calls[0][1]).toBe(options);
    expect(delegate.mock.contexts[0]).toBe(extended);
    expect(client.label).toBe(model);
  });

  it('buffers interactive writes and entries, forwarding tx, options and callback result', async () => {
    const tx = {};
    const options = { timeout: 1234 };
    const delegate = vi.fn((fn: (value: object) => Promise<unknown>, _options?: object) => fn(tx));
    const extended = { $transaction: delegate };
    const client = clientWithExtended(extended);
    await openAuditScope('POST /x', async (scope) => {
      await expect(client.$transaction(async (value) => {
        expect(value).toBe(tx);
        noteAuditWrite('Label.create');
        noteAuditEntry();
        expect(scope.writes).toEqual([]);
        expect(scope.entries).toBe(0);
        return 42;
      }, options)).resolves.toBe(42);
      expect(scope.writes).toEqual(['Label.create']);
      expect(scope.entries).toBe(1);
    });
    expect(delegate.mock.contexts[0]).toBe(extended);
    expect(delegate.mock.calls[0][1]).toBe(options);
  });

  it('drops counts when the interactive callback rejects', async () => {
    const failure = new Error('rollback');
    const delegate = vi.fn((fn: (tx: object) => Promise<unknown>) => fn({}));
    const client = clientWithExtended({ $transaction: delegate });
    await openAuditScope('POST /x', async (scope) => {
      await expect(client.$transaction(async () => {
        noteAuditWrite('Label.create');
        noteAuditEntry();
        throw failure;
      })).rejects.toBe(failure);
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(0);
    });
  });

  it('flushes on callback success even if commit subsequently rejects', async () => {
    const failure = new Error('commit failed');
    const delegate = vi.fn(async (fn: (tx: object) => Promise<unknown>) => {
      await fn({});
      throw failure;
    });
    const client = clientWithExtended({ $transaction: delegate });
    await openAuditScope('POST /x', async (scope) => {
      await expect(client.$transaction(async () => {
        noteAuditWrite('Label.create');
        noteAuditEntry();
      })).rejects.toBe(failure);
      expect(scope.writes).toEqual(['Label.create']);
      expect(scope.entries).toBe(1);
    });
  });
});
