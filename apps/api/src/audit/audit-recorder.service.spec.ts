import type { IAuditStorage } from '@nathapp/nestjs-audit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAuditScope } from '../action-context/audit-coverage';
import { runAsSystem, runWithActionContext, runWithActor } from '../action-context/action-context';
import { AuditRecorder } from './audit-recorder.service';

describe('AuditRecorder', () => {
  const record = vi.fn<IAuditStorage['record']>();
  const storage = { record } satisfies IAuditStorage;
  const txManager = { isInTransaction: vi.fn(() => true) };
  const recorder = new AuditRecorder(storage, txManager as never);
  const input = { key: 'ticket.create', resourceType: 'ticket', resourceId: 't1' };

  beforeEach(() => {
    record.mockReset();
    record.mockResolvedValue(undefined);
  });

  it('coverage AC-5: counts an entry only after storage resolves', async () => {
    let finish!: () => void;
    record.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await openAuditScope('POST /x', async (scope) => {
      expect(scope.entries).toBe(0);
      const pending = recorder.record(input);
      expect(record).toHaveBeenCalledOnce();
      expect(scope.entries).toBe(0);
      finish();
      await pending;
      expect(scope.entries).toBe(1);
    });
  });

  it('coverage AC-6: propagates storage failure without counting an entry', async () => {
    const failure = new Error('storage failure');
    record.mockRejectedValueOnce(failure);
    await openAuditScope('POST /x', async (scope) => {
      await expect(recorder.record(input)).rejects.toBe(failure);
      expect(record).toHaveBeenCalledOnce();
      expect(scope.entries).toBe(0);
    });
  });

  it('AC-1/2/3: maps current actor, resource and origin', async () => {
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record(input));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ticket.create', resource: 'ticket', resourceId: 't1', actor: { id: 'u1', type: 'USER' },
      metadata: expect.objectContaining({ origin: 'rest', onBehalfOf: null }),
    }));
  });

  it('AC-4/5: maps system actor and on-behalf-of', async () => {
    await runAsSystem('assistant', () => recorder.record(input), { onBehalfOf: { type: 'AGENT', id: 'a1' } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: 'assistant', type: 'SYSTEM' },
      metadata: expect.objectContaining({ onBehalfOf: { type: 'AGENT', id: 'a1' } }),
    }));
  });

  it('AC-6/7: maps approval and correlation id', async () => {
    const approval = { requiredMode: 'human' as const, satisfiedBy: 'human' as const, approverType: 'USER' as const, approverId: 'u2', requestId: 'pa1' };
    await runWithActionContext({ actor: { type: 'USER', id: 'u1' }, origin: 'mcp', approval, correlationId: 'c-7' }, () => recorder.record(input));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'c-7', metadata: expect.objectContaining({ approval }) }));
  });

  it('AC-8/9: stores project id or null', async () => {
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record({ ...input, projectId: 'p1' }));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ projectId: 'p1' });
    record.mockClear();
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record(input));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ projectId: null });
  });

  it('AC-10/11/12/13: stores optional summary capped at 500 characters', async () => {
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record({ ...input, summary: 'status OPEN -> CLOSED' }));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ summary: 'status OPEN -> CLOSED' });
    record.mockClear();
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record(input));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ summary: null });
    record.mockClear();
    const long = 'x'.repeat(600);
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record({ ...input, summary: long }));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ summary: long.slice(0, 500) });
    record.mockClear();
    const exact = 'x'.repeat(500);
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record({ ...input, summary: exact }));
    expect(record.mock.calls[0][0].metadata).toMatchObject({ summary: exact });
  });

  it('US-004 AC-6: records a forge user approver unchanged', async () => {
    const approval = { requiredMode: 'human' as const, satisfiedBy: 'human' as const, approverType: 'FORGE_USER' as const, approverId: 'github:alice' };
    await runWithActionContext({ actor: { type: 'SYSTEM', id: 'review' }, origin: 'system', approval }, () => recorder.record(input));
    expect(record.mock.calls[0][0].metadata.approval).toEqual(approval);
  });

  it('AC-14: timestamps the record during the call', async () => {
    const before = new Date();
    await runWithActor({ type: 'USER', id: 'u1' }, () => recorder.record(input));
    const after = new Date();
    const timestamp = record.mock.calls[0][0].timestamp;
    expect(timestamp).toBeInstanceOf(Date);
    expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
