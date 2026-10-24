import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAsSystem, runWithActionContext, runWithActor } from '../action-context/action-context';
import { AuditRecorder } from './audit-recorder.service';

describe('AuditRecorder', () => {
  const record = vi.fn<IAuditStorage['record']>();
  const storage = { record } satisfies IAuditStorage;
  const txManager = { isInTransaction: vi.fn(() => true) };
  const recorder = new AuditRecorder(storage, txManager as never);
  const input = { key: 'ticket.create', resourceType: 'ticket', resourceId: 't1' };

  afterEach(() => record.mockClear());

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
