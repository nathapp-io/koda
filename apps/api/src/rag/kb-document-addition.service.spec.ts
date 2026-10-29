import { KbAdditionJournal } from './kb-addition-journal';
import { KbDocumentAddition } from './kb-document-addition.service';
import { RagService } from './rag.service';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import type { AgentPrincipal } from '../auth/principal/koda-principal.types';
import { ForbiddenAppException } from '@nathapp/nestjs-common';

const principal: AgentPrincipal = { actorType: 'agent', id: 'a1', slug: 'bot', name: 'Bot', status: 'ACTIVE', agentRoles: [], capabilities: [], blacklisted: false, revoked: false, authorities: [] };
const dto = { source: 'manual' as const, sourceId: 's1', content: 'hello' };
describe('KbDocumentAddition', () => {
  const rag = { embedForIndex: vi.fn(), findSourceCreators: vi.fn(), indexDocument: vi.fn() };
  const permissions = { can: vi.fn() };
  const audit = { audited: vi.fn(async (work: () => Promise<unknown>, entry: () => unknown) => { await work(); return entry(); }) };
  let addition: KbDocumentAddition;
  beforeEach(() => {
    vi.resetAllMocks();
    rag.embedForIndex.mockResolvedValue([1, 2]);
    rag.findSourceCreators.mockResolvedValue([]);
    rag.indexDocument.mockResolvedValue('row1');
    permissions.can.mockResolvedValue({ allowed: false });
    audit.audited.mockImplementation(async (work, entry) => { await work(); return entry(); });
    const journal = {
      run: vi.fn(async (_projectId, work) => work({})),
      prepare: vi.fn(async (projectId, source, sourceId) => ({ id: 'intent1', key: 'kb.document.add', projectId, resourceType: 'kb-document', resourceId: `${source}:${sourceId}` })),
    };
    addition = new KbDocumentAddition(rag as unknown as RagService, permissions as unknown as PermissionService, audit as unknown as AuditRecorder, journal as unknown as KbAdditionJournal);
  });
  it('AC-7: embeds in prepare and writes once with the vector and trusted creator in callback', async () => {
    const apply = await addition.prepare(principal, 'p1', dto);
    expect(rag.embedForIndex).toHaveBeenCalledWith('hello');
    expect(rag.indexDocument).not.toHaveBeenCalled();
    expect(rag.findSourceCreators).not.toHaveBeenCalled();
    await expect(apply()).resolves.toEqual({ indexed: true, id: 'row1', sourceId: 's1' });
    expect(rag.indexDocument).toHaveBeenCalledExactlyOnceWith('p1', { ...dto, metadata: {}, createdBy: { type: 'AGENT', id: 'a1' } }, [1, 2]);
    expect(audit.audited).toHaveBeenCalledTimes(1);
    expect(audit.audited.mock.calls[0][1]()).toMatchObject({ key: 'kb.document.add', resourceId: 'manual:s1', projectId: 'p1' });
  });
  it('AC-8: rechecks another creator at callback time and refuses without writing', async () => {
    const apply = await addition.prepare(principal, 'p1', dto);
    rag.findSourceCreators.mockResolvedValue([{ type: 'USER', id: 'root' }]);
    await expect(apply()).rejects.toBeInstanceOf(ForbiddenAppException);
    await expect(apply()).rejects.toMatchObject({ response: { prefix: 'permissions' } });
    expect(permissions.can).toHaveBeenCalledWith(principal, 'kb.document.delete', { projectId: 'p1' });
    expect(rag.indexDocument).not.toHaveBeenCalled();
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it('AC-10: no embedding service means no write or audit', async () => {
    rag.embedForIndex.mockResolvedValue(null);
    const apply = await addition.prepare(principal, 'p1', dto);
    await expect(apply()).resolves.toEqual({ indexed: false, sourceId: 's1' });
    expect(rag.indexDocument).not.toHaveBeenCalled();
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it.each([{ creators: [] }, { creators: [{ type: 'AGENT', id: 'a1' }] }])('allows new and own pairs without a delete grant: %j', async ({ creators }) => {
    rag.findSourceCreators.mockResolvedValue(creators);
    await addition.add(principal, 'p1', dto);
    expect(permissions.can).not.toHaveBeenCalled();
    expect(rag.indexDocument).toHaveBeenCalledTimes(1);
  });
  it('attributes a user from the principal, not metadata', async () => {
    const user = { actorType: 'user' as const, id: 'u1', name: 'User', email: 'user@test.dev', role: 'MEMBER' as const, authorities: [], blacklisted: false, revoked: false };
    await addition.add(user, 'p1', { ...dto, metadata: { kodaCreatedBy: { type: 'AGENT', id: 'spoof' } } });
    expect(rag.indexDocument).toHaveBeenCalledWith('p1', expect.objectContaining({ createdBy: { type: 'USER', id: 'u1' } }), [1, 2]);
  });
  it('does not audit when indexing returns null', async () => {
    rag.indexDocument.mockResolvedValue(null);
    await expect(addition.add(principal, 'p1', dto)).resolves.toEqual({ indexed: false, sourceId: 's1' });
    expect(audit.audited).not.toHaveBeenCalled();
  });
  it('propagates filter validation without writing', async () => {
    const { ValidationAppException } = await import('@nathapp/nestjs-common');
    rag.findSourceCreators.mockRejectedValue(new ValidationAppException());
    await expect(addition.add(principal, 'p1', dto)).rejects.toBeInstanceOf(ValidationAppException);
    expect(rag.indexDocument).not.toHaveBeenCalled();
  });
  it('allows replacement of a system row with any-row delete', async () => {
    rag.findSourceCreators.mockResolvedValue([null]);
    permissions.can.mockResolvedValue({ allowed: true });
    await addition.add(principal, 'p1', dto);
    expect(rag.indexDocument).toHaveBeenCalledTimes(1);
  });
});
