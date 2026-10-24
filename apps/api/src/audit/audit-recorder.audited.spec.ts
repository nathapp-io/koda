import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { describe, expect, it, vi } from 'vitest';
import { AuditRecorder, type AuditRecordInput } from './audit-recorder.service';

const entry: AuditRecordInput = { key: 'label.create', resourceType: 'label', resourceId: 'l1' };

describe('AuditRecorder.audited', () => {
  it('AC-1/2/3/4: runs once, derives entries after fn, records each, and returns fn value', async () => {
    const events: string[] = [];
    const value = { id: 'l1' };
    const fn = vi.fn(async () => { events.push('fn'); return value; });
    const entriesOf = vi.fn((result: typeof value) => { events.push('entries'); expect(result).toBe(value); return [entry, { ...entry, resourceId: 'l2' }]; });
    const record = vi.fn(async () => { events.push('record'); });
    const txManager = { run: vi.fn(async <T>(callback: () => Promise<T>) => callback()), isInTransaction: vi.fn(() => true) };
    const recorder = new AuditRecorder({ record } as unknown as IAuditStorage, txManager as unknown as ITransactionManager);
    await expect(recorder.audited(fn, entriesOf)).resolves.toBe(value);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(entriesOf).toHaveBeenCalledWith(value);
    expect(record).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['fn', 'entries', 'record', 'record']);
  });

  it('AC-5/6: propagates fn rejection without deriving or recording entries', async () => {
    const failure = new Error('write failed');
    const fn = vi.fn(async () => { throw failure; });
    const entriesOf = vi.fn(() => entry);
    const record = vi.fn(async () => undefined);
    const recorder = new AuditRecorder({ record } as unknown as IAuditStorage, { run: async (cb: () => Promise<unknown>) => cb(), isInTransaction: () => true } as unknown as ITransactionManager);
    await expect(recorder.audited(fn, entriesOf)).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(entriesOf).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('AC-7/8: invokes the transaction once and records while it is open', async () => {
    let open = false;
    const record = vi.fn(async () => { expect(open).toBe(true); });
    const txManager = { run: vi.fn(async <T>(callback: () => Promise<T>) => { open = true; try { return await callback(); } finally { open = false; } }), isInTransaction: () => open };
    const recorder = new AuditRecorder({ record } as unknown as IAuditStorage, txManager as unknown as ITransactionManager);
    await recorder.audited(async () => 'ok', () => entry);
    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('AC-20/21: returns the fn value and does not record for an empty entry list', async () => {
    const record = vi.fn(async () => undefined);
    const recorder = new AuditRecorder({ record } as unknown as IAuditStorage, { run: async <T>(cb: () => Promise<T>) => cb(), isInTransaction: () => true } as unknown as ITransactionManager);
    await expect(recorder.audited(async () => 42, () => [])).resolves.toBe(42);
    expect(record).not.toHaveBeenCalled();
  });
});
