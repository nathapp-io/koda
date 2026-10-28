import { KbDeletionJournal } from './kb-deletion-journal';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IRagConfig } from '../config/rag.config';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { KbDocumentDeletion } from './kb-document-deletion.service';
import { RagService } from './rag.service';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { UserPrincipal } from '../auth/principal/koda-principal.types';

const principal = { actorType: 'user', id: 'u1' } as UserPrincipal;
const owner = { type: 'USER' as const, id: 'u1' };

describe('KbDocumentDeletion', () => {
  const rag = { findSourceCreators: vi.fn(), deleteBySource: vi.fn(), withDocumentWriteLock: vi.fn() };
  const permissions = { can: vi.fn() };
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>, entries: () => unknown) => { await fn(); return entries(); }) };
  let service: KbDocumentDeletion;
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  beforeEach(() => {
    vi.resetAllMocks();
    rag.withDocumentWriteLock.mockImplementation(async (projectId, fn) => fn({
      findSourceRowIds: async (source: string) => {
        const read = rag.findSourceCreators.mock.calls.findIndex(call => call[1] === source);
        const creators = await rag.findSourceCreators.mock.results[read]?.value as unknown[];
        return (creators ?? []).map((_creator, index) => `${source}-${index}`);
      },
      deleteBySource: (source: string, sourceId: string) => rag.deleteBySource(projectId, source, sourceId) }));
    rag.findSourceCreators.mockResolvedValue([owner]);
    permissions.can.mockResolvedValue({ allowed: true });
    audit.audited.mockImplementation(async (fn, entries) => { await fn(); return entries(); });
    root = mkdtempSync(join(tmpdir(), 'koda-kb-service-'));
    const journal = new KbDeletionJournal({ lancedbPath: root, inMemoryOnly: false } as IRagConfig, rag as unknown as RagService, audit as unknown as AuditRecorder);
    service = new KbDocumentDeletion(rag as unknown as RagService, permissions as unknown as PermissionService, audit as unknown as AuditRecorder, journal);
  });
  it('AC-8: preflights every creator in both user sources', async () => {
    rag.findSourceCreators.mockResolvedValueOnce([owner, null]).mockResolvedValueOnce([{ type: 'AGENT', id: 'a1' }]);
    expect(await service.preflight(principal, 'p1', 's1')).toHaveLength(2);
    expect(rag.findSourceCreators.mock.calls).toEqual([['p1', 'doc', 's1'], ['p1', 'manual', 's1']]);
    for (const createdBy of [owner, null, { type: 'AGENT', id: 'a1' }]) {
      expect(permissions.can).toHaveBeenCalledWith(principal, 'kb.document.delete', { projectId: 'p1', resource: { createdBy } });
    }
  });
  it('AC-9: checks all sources before the first delete', async () => {
    rag.deleteBySource.mockImplementation(async () => { expect(permissions.can).toHaveBeenCalledTimes(2); });
    await service.delete(principal, 'p1', 's1');
    expect(rag.deleteBySource.mock.calls).toEqual([['p1', 'doc', 's1'], ['p1', 'manual', 's1']]);
  });
  it('AC-9: refuses before any deletion, including system rows', async () => {
    rag.findSourceCreators.mockResolvedValueOnce([owner]).mockResolvedValueOnce([null]);
    permissions.can.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });
    await expect(service.delete(principal, 'p1', 's1')).rejects.toThrow(ForbiddenAppException);
    expect(rag.deleteBySource).not.toHaveBeenCalled();
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it('AC-10: audits only sources with matching rows', async () => {
    rag.findSourceCreators.mockResolvedValueOnce([]).mockResolvedValueOnce([owner]);
    await service.delete(principal, 'p1', 's1');
    expect(audit.audited).toHaveBeenCalledTimes(1);
    expect(audit.audited.mock.calls[0][1]()).toEqual({ id: expect.any(String), key: 'kb.document.delete', resourceType: 'kb-document', resourceId: 'manual:s1', projectId: 'p1', summary: 'deleted 1 manual rows' });
  });
  it('F3: fails closed before any delete if the durable journal cannot be written', async () => {
    rmSync(root, { recursive: true, force: true });
    writeFileSync(root, 'not a directory');
    await expect(service.delete(principal, 'p1', 's1')).rejects.toThrow();
    expect(rag.deleteBySource).not.toHaveBeenCalled();
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it('restricts to the specified source', async () => {
    await service.delete(principal, 'p1', 's1', 'manual');
    expect(rag.deleteBySource.mock.calls).toEqual([['p1', 'manual', 's1']]);
  });
  it('preserves filter-safe id validation before writes', async () => {
    rag.findSourceCreators.mockRejectedValue(new ValidationAppException());
    await expect(service.delete(principal, 'p1', "x'y")).rejects.toThrow(ValidationAppException);
    expect(rag.deleteBySource).not.toHaveBeenCalled();
  });
  it('rechecks ownership after an earlier successful preflight', async () => {
    await service.preflight(principal, 'p1', 's1');
    permissions.can.mockResolvedValue({ allowed: false });
    await expect(service.delete(principal, 'p1', 's1')).rejects.toThrow(ForbiddenAppException);
    expect(rag.deleteBySource).not.toHaveBeenCalled();
  });
});
