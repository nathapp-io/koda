import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KbDeletionJournal } from './kb-deletion-journal';
import { KbDocumentDeletion } from './kb-document-deletion.service';
import type { RagService, KbDocumentWriteSession } from './rag.service';
import type { AuditRecorder, AuditRecordInput } from '../audit/audit-recorder.service';
import type { PermissionService } from '../permissions/permission.service';
import type { AgentPrincipal } from '../auth/principal/koda-principal.types';
import type { IRagConfig } from '../config/rag.config';
import { runWithActionContext, currentContext } from '../action-context/action-context';

it('F3: after delete/audit failure, a restarted journal recovers the audit with original approval provenance without deleting replacements', async () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-delete-journal-'));
  const config = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
  let rows = ['old'];
  const session = {
    findSourceRowIds: async () => [...rows],
    deleteBySource: async () => { rows = []; },
    deleteRows: async (ids: readonly string[]) => { rows = rows.filter(id => !ids.includes(id)); },
  } satisfies KbDocumentWriteSession;
  const rag = {
    findSourceCreators: vi.fn().mockResolvedValue([{ type: 'AGENT', id: 'a1' }]),
    withDocumentWriteLock: async (_project: string, fn: (session: KbDocumentWriteSession) => Promise<unknown>) => fn(session),
  } as unknown as RagService;
  const saved: Array<{ entry: AuditRecordInput; context: unknown }> = [];
  let fail = true;
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>, entries: () => AuditRecordInput | readonly AuditRecordInput[]) => {
    await fn();
    if (fail) throw new Error('audit storage unavailable');
    const entriesToSave = entries();
    for (const entry of Array.isArray(entriesToSave) ? entriesToSave : [entriesToSave]) saved.push({ entry, context: currentContext() });
  }) } as unknown as AuditRecorder;
  try {
    const journal = new KbDeletionJournal(config, rag, audit);
    const deletion = new KbDocumentDeletion(rag, { can: async () => ({ allowed: true }) } as unknown as PermissionService, audit, journal);
    await expect(runWithActionContext({ actor: { type: 'AGENT', id: 'a1' }, origin: 'rest', approval: { requiredMode: 'human', satisfiedBy: 'human', requestId: 'approval-1' }, correlationId: 'correlation-1' }, () => deletion.delete({ actorType: 'agent', id: 'a1' } as AgentPrincipal, 'p1', 's1', 'doc'))).rejects.toThrow('audit storage unavailable');
    expect(rows).toEqual([]);
    expect(saved).toEqual([]);
    expect(readdirSync(join(root, 'kb-delete-journal')).filter(name => name.endsWith('.json'))).toHaveLength(1);
    rows = ['replacement'];
    // An outage across multiple sweeps must retain the receipt, not acknowledge it early.
    await new KbDeletionJournal(config, rag, audit).recover();
    expect(saved).toEqual([]);
    expect(readdirSync(join(root, 'kb-delete-journal')).filter(name => name.endsWith('.json'))).toHaveLength(1);
    fail = false;
    const restarted = new KbDeletionJournal(config, rag, audit);
    await restarted.recover();
    expect(rows).toEqual(['replacement']);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ entry: { id: expect.any(String), key: 'kb.document.delete', resourceId: 'doc:s1' }, context: { actor: { type: 'AGENT', id: 'a1' }, approval: { requestId: 'approval-1' }, correlationId: 'correlation-1' } });
    await restarted.recover();
    expect(saved).toHaveLength(1);
    expect(readdirSync(join(root, 'kb-delete-journal'))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
