import { describe, expect, it, vi } from 'vitest';
import type { AuditEntry as PackageAuditEntry } from '@nathapp/nestjs-audit';
import { PrismaAuditStorage } from './prisma-audit.storage';
import type { AuditEntryRecord } from './domain/audit-entry.domain';

describe('PrismaAuditStorage', () => {
  const timestamp = new Date('2026-01-02T03:04:05.000Z');
  const base = {
    action: 'ticket.create', resource: 'ticket', resourceId: 't1', actor: { id: 'u1', type: 'USER' },
    correlationId: 'c1', timestamp,
    metadata: { projectId: 'p1', onBehalfOf: null, origin: 'rest', approval: { requiredMode: 'none', satisfiedBy: 'none' }, summary: null },
  } as unknown as PackageAuditEntry;
  const setup = () => {
    const create = vi.fn<(record: AuditEntryRecord) => Promise<unknown>>().mockResolvedValue({});
    return { create, storage: new PrismaAuditStorage({ create } as never) };
  };
  it('F3: routes stable journal ids to conflict-safe insertion for replay', async () => {
    const create = vi.fn(); const createOnce = vi.fn().mockResolvedValue(undefined);
    const storage = new PrismaAuditStorage({ create, createOnce } as never);
    await storage.record({ ...base, metadata: { ...base.metadata, recordId: 'journal-audit-id' } } as PackageAuditEntry);
    expect(createOnce).toHaveBeenCalledWith(expect.objectContaining({ id: 'journal-audit-id', key: 'ticket.create' }));
    expect(create).not.toHaveBeenCalled();
  });
  it('AC-1: maps action, resource, actor and correlation fields', async () => {
    const { create, storage } = setup(); await storage.record(base);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', actorType: 'USER', actorId: 'u1', correlationId: 'c1' }));
  });
  it('AC-2: maps timestamp and project', async () => {
    const { create, storage } = setup(); await storage.record(base);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdAt: timestamp, projectId: 'p1' }));
  });
  it('AC-3: maps delegation actor', async () => {
    const { create, storage } = setup(); await storage.record({ ...base, metadata: { ...base.metadata, onBehalfOf: { type: 'AGENT', id: 'a1' } } } as PackageAuditEntry);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ onBehalfOfType: 'AGENT', onBehalfOfId: 'a1' }));
  });
  it('AC-4: maps approval details', async () => {
    const { create, storage } = setup(); await storage.record({ ...base, metadata: { ...base.metadata, approval: { requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' } } } as PackageAuditEntry);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', approvalRequestId: 'pa1' }));
  });
  it('AC-5: nulls absent optional fields', async () => {
    const { create, storage } = setup(); await storage.record(base);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ onBehalfOfType: null, onBehalfOfId: null, approverType: null, approverId: null, approvalRequestId: null, summary: null }));
  });
  it('AC-6: maps summary', async () => {
    const { create, storage } = setup(); await storage.record({ ...base, metadata: { ...base.metadata, summary: 'status OPEN -> CLOSED' } } as PackageAuditEntry);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ summary: 'status OPEN -> CLOSED' }));
  });
  const invalid: Array<[string, PackageAuditEntry, string]> = [
    ['AC-7', { ...base, actor: undefined } as unknown as PackageAuditEntry, 'actor'],
    ['AC-8', { ...base, correlationId: undefined } as unknown as PackageAuditEntry, 'correlationId'],
    ['AC-9', { ...base, metadata: undefined } as unknown as PackageAuditEntry, 'metadata'],
    ['AC-10', { ...base, metadata: { ...base.metadata, approval: undefined } } as PackageAuditEntry, 'metadata.approval'],
    ['AC-11', { ...base, actor: { id: 'u1' } } as PackageAuditEntry, 'actor.type'],
    ['AC-12', { ...base, actor: undefined, correlationId: undefined } as unknown as PackageAuditEntry, 'actor'],
  ];
  for (const [ac, entry, field] of invalid) it(`${ac}: rejects missing ${field} before create`, async () => {
    const { create, storage } = setup();
    await expect(storage.record(entry)).rejects.toThrow(`audit entry is not a koda audit entry: ${field}`);
    expect(create).not.toHaveBeenCalled();
  });
});
