vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
import * as fs from 'node:fs';
import { mkdtempSync, opendirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

it('F3 round 2: a hundred failing receipts do not starve the next committed deletion audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-journal-fair-'));
  const config = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
  const session: KbDocumentWriteSession = {
    findSourceRowIds: async () => ['old'], deleteBySource: async () => {}, deleteRows: async () => {},
  };
  const rag = { withDocumentWriteLock: async (_project: string, fn: (session: KbDocumentWriteSession) => Promise<unknown>) => fn(session) } as unknown as RagService;
  let healthyResource = '';
  const recovered: string[] = [];
  const attempts = vi.fn();
  const audit = { audited: async (fn: () => Promise<unknown>, entries: () => readonly AuditRecordInput[]) => {
    await fn();
    const entry = entries()[0]; attempts(entry.resourceId);
    if (entry.resourceId !== healthyResource) throw new Error('persistent per-receipt failure');
    recovered.push(entry.resourceId);
  } } as unknown as AuditRecorder;
  const journal = new KbDeletionJournal(config, rag, audit);
  try {
    for (let i = 0; i < 101; i++) await journal.prepare('p1', `s${i}`, ['doc'], session);
    // Pick the last receipt in the actual directory iteration order, not filename creation order.
    const dir = opendirSync(join(root, 'kb-delete-journal'));
    let last = '';
    try { for (let file = dir.readSync(); file !== null; file = dir.readSync()) last = file.name; }
    finally { dir.closeSync(); }
    healthyResource = (JSON.parse(readFileSync(join(root, 'kb-delete-journal', last), 'utf8')) as { sources: Array<{ audit: AuditRecordInput }> }).sources[0].audit.resourceId;
    await journal.recover();
    expect(attempts).toHaveBeenCalledTimes(100);
    expect(recovered).toEqual([]);
    await journal.recover();
    expect(recovered).toEqual([healthyResource]);
    expect(readdirSync(join(root, 'kb-delete-journal')).filter(name => name.endsWith('.json'))).toHaveLength(100);
    await journal.recover();
    expect(attempts).toHaveBeenCalledTimes(201);
    expect(recovered).toEqual([healthyResource]);
  } finally {
    // Lifecycle closure is used when fair sweeps retain a directory cursor between batches.
    journal.onModuleDestroy();
    rmSync(root, { recursive: true, force: true });
  }
});

it('F4 round 2: fsync failure after rename aborts preparation and is never replayed after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-journal-abort-'));
  const config = { lancedbPath: root, inMemoryOnly: false } as IRagConfig;
  let rows = ['old'];
  const session: KbDocumentWriteSession = {
    findSourceRowIds: async () => [...rows],
    deleteBySource: async () => { rows = []; },
    deleteRows: async () => { rows = []; },
  };
  const rag = { findSourceCreators: async () => [{ type: 'AGENT', id: 'a1' }], withDocumentWriteLock: async (_project: string, fn: (session: KbDocumentWriteSession) => Promise<unknown>) => fn(session) } as unknown as RagService;
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>) => fn()) } as unknown as AuditRecorder;
  const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync;
  let calls = 0;
  const sync = vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    calls++;
    // parent sync, file sync, then directory sync immediately after rename.
    if (calls === 3) {
      expect(readdirSync(join(root, 'kb-delete-journal')).some(name => name.endsWith('.json'))).toBe(true);
      throw new Error('injected directory fsync failure');
    }
    original(fd);
  });
  try {
    const journal = new KbDeletionJournal(config, rag, audit);
    const deletion = new KbDocumentDeletion(rag, { can: async () => ({ allowed: true }) } as unknown as PermissionService, audit, journal);
    await expect(deletion.delete({ actorType: 'agent', id: 'a1' } as AgentPrincipal, 'p1', 's1', 'doc')).rejects.toThrow('injected directory fsync failure');
    expect(rows).toEqual(['old']);
    sync.mockRestore();
    await new KbDeletionJournal(config, rag, audit).recover();
    expect(rows).toEqual(['old']);
    expect(audit.audited).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'kb-delete-journal')).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(readdirSync(join(root, 'kb-delete-journal')).filter(name => name.endsWith('.aborted'))).toHaveLength(1);
    expect(calls).toBe(4);
  } finally { sync.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
