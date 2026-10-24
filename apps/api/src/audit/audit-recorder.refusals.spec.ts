import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_APPROVAL } from '../action-context/action-context';
import { AuditRecorder } from './audit-recorder.service';

const record = vi.fn<IAuditStorage['record']>();
const storage = { record } satisfies IAuditStorage;
const txManager = { isInTransaction: vi.fn(() => true) };
const recorder = new AuditRecorder(storage, txManager as never);
const input = { key: 'ticket.create', resourceType: 'ticket', resourceId: 't1' };

describe('AuditRecorder refusals and fallback', () => {
  afterEach(() => {
    record.mockReset();
    record.mockResolvedValue(undefined);
    txManager.isInTransaction.mockReturnValue(true);
  });

  it('AC-1/2/3: supplies the system fallback without an action context', async () => {
    await recorder.record(input);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: 'unknown', type: 'SYSTEM' },
      metadata: expect.objectContaining({ origin: 'system', approval: NO_APPROVAL }),
    }));
  });

  it('AC-4: assigns each context-less record a fresh correlation id', async () => {
    await recorder.record(input);
    await recorder.record(input);
    const ids = record.mock.calls.map(([entry]) => entry.correlationId);
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids[0].length).toBeGreaterThan(0);
    expect(ids[1]).toEqual(expect.any(String));
    expect(ids[1].length).toBeGreaterThan(0);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('AC-5/6: refuses unknown catalog keys before storage', async () => {
    await expect(recorder.record({ ...input, key: 'no.such.key' })).rejects.toHaveProperty('message', 'unknown audit key: no.such.key');
    expect(record).not.toHaveBeenCalled();
  });

  it('AC-7/8: refuses calls outside a transaction before storage', async () => {
    txManager.isInTransaction.mockReturnValue(false);
    await expect(recorder.record(input)).rejects.toHaveProperty('message', 'AuditRecorder.record must run inside a transaction');
    expect(record).not.toHaveBeenCalled();
  });

  it('AC-9: propagates the exact storage rejection', async () => {
    const error = new Error('storage unavailable');
    record.mockRejectedValueOnce(error);
    await expect(recorder.record(input)).rejects.toBe(error);
  });
});
