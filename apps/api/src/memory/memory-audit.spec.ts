import type { Mock } from 'vitest';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import { memoryAuditHook, memoryWriteSummary, type MemoryWritten } from './memory-audit';
import type { MemoryItem } from './memory-item-repository';

/**
 * Permissions P2 US-002 — the two pure pieces of a memory write's audit entry: the summary a human reads
 * (never the item's text) and the `onWritten` hook the repository calls inside its transaction.
 */

const SUBJECT = 'svc-private-subject';
const PREDICATE = 'owner-private-predicate';
const OBJECT = 'Private fact object';

const makeItem = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: 'mem-1',
  projectId: 'project-1',
  kind: 'FACT',
  subject: SUBJECT,
  predicate: PREDICATE,
  object: OBJECT,
  status: 'active',
  confidence: 0.8,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const written = (item: Partial<MemoryItem>, superseded: MemoryItem | null = null): MemoryWritten => ({
  item: makeItem(item),
  superseded,
});

describe('memoryWriteSummary', () => {
  it('AC-21: names the created item\'s kind when it superseded nothing', () => {
    expect(memoryWriteSummary(written({ kind: 'FACT' }))).toBe('created FACT');
  });

  it('AC-22: names the superseded item\'s id when the write replaced one', () => {
    expect(memoryWriteSummary(written({ kind: 'DECISION' }, makeItem({ id: 'm-0' }))))
      .toBe('created DECISION, superseded m-0');
  });

  it('never carries the subject, predicate or object of either item', () => {
    const summary = memoryWriteSummary(written({}, makeItem({ id: 'm-0' })));

    expect(summary).toBe('created FACT, superseded m-0');
    for (const secret of [SUBJECT, PREDICATE, OBJECT]) expect(summary).not.toContain(secret);
  });
});

describe('memoryAuditHook', () => {
  const recorder = () => ({ record: vi.fn(async () => undefined) } as unknown as AuditRecorder & { record: Mock });

  it('AC-23: records the key on the new item, as a memory-item of the item\'s project', async () => {
    const audit = recorder();

    await memoryAuditHook(audit, 'memory.extract')({
      item: { id: 'm-1', projectId: 'p-1', kind: 'FACT' } as MemoryItem,
      superseded: null,
    });

    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      key: 'memory.extract',
      resourceType: 'memory-item',
      resourceId: 'm-1',
      projectId: 'p-1',
      summary: 'created FACT',
    });
  });

  it('records the superseded id for a replacement', async () => {
    const audit = recorder();

    await memoryAuditHook(audit, 'memory.decision.record')({
      item: makeItem({ id: 'm-2' }),
      superseded: makeItem({ id: 'm-1' }),
    });

    expect(audit.record).toHaveBeenCalledWith({
      key: 'memory.decision.record',
      resourceType: 'memory-item',
      resourceId: 'm-2',
      projectId: 'project-1',
      summary: 'created FACT, superseded m-1',
    });
  });

  it('lets the recorder\'s refusal reach the caller, so the upsert transaction rolls back', async () => {
    const audit = recorder();
    const refusal = new Error('audit down');
    audit.record.mockRejectedValueOnce(refusal);

    await expect(
      memoryAuditHook(audit, 'memory.create')({ item: makeItem(), superseded: null }),
    ).rejects.toBe(refusal);
  });
});
