import { KbDeletionJournal } from './kb-deletion-journal';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from './vector-store.service';
import { LanceTableManager } from './lance-table-manager';
import { RagService } from './rag.service';
import { KbDocumentDeletion } from './kb-document-deletion.service';
import type { IRagConfig } from '../config/rag.config';
import type { EmbeddingService } from './embedding.service';
import type { PermissionService } from '../permissions/permission.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { AgentPrincipal } from '../auth/principal/koda-principal.types';

const root = mkdtempSync(join(tmpdir(), 'koda-delete-race-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const config = { inMemoryOnly: true, lancedbPath: root, embeddingProvider: 'fake', embeddingModel: 'test', ftsIndexMode: 'simple' } as IRagConfig;
const barrier = () => { let resolve = () => {}; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it.each(['doc', 'manual'] as const)('F2: a %s replacement queued between ownership check and both-source deletion survives', async source => {
  const manager = new LanceTableManager(config);
  const vector = new VectorStore(config, { embed: async () => [1, 0], provider: 'fake', model: 'test' } as unknown as EmbeddingService, undefined, undefined, undefined, manager);
  const rag = new RagService(vector);
  const doc = { source: 'doc' as const, sourceId: 's1', content: 'owned', metadata: {}, createdBy: { type: 'AGENT' as const, id: 'a1' } };
  await rag.indexDocument('p1', doc);
  await rag.indexDocument('p1', { ...doc, source: 'manual' });
  const checked = barrier(); const release = barrier(); const queued = barrier();
  const permissions = { can: vi.fn(async () => { checked.resolve(); await release.promise; return { allowed: true }; }) };
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const journal = new KbDeletionJournal(config, rag, audit as unknown as AuditRecorder);
  const deletion = new KbDocumentDeletion(rag, permissions as unknown as PermissionService, audit as unknown as AuditRecorder, journal);
  const deleting = deletion.delete({ actorType: 'agent', id: 'a1' } as AgentPrincipal, 'p1', 's1');
  await checked.promise;
  const original = manager.exclusive.bind(manager);
  const spy = vi.spyOn(manager, 'exclusive').mockImplementation((table, fn) => {
    const pending = original(table, fn); queued.resolve(); return pending;
  });
  try {
    const replacing = rag.indexDocument('p1', { ...doc, source, content: 'replacement', createdBy: { type: 'USER', id: 'other' } });
    await queued.promise;
    release.resolve();
    await Promise.all([deleting, replacing]);
    expect(await rag.findSourceCreators('p1', source, 's1')).toEqual([{ type: 'USER', id: 'other' }]);
    expect(await rag.findSourceCreators('p1', source === 'doc' ? 'manual' : 'doc', 's1')).toEqual([]);
  } finally { release.resolve(); spy.mockRestore(); journal.onModuleDestroy(); await vector.onModuleDestroy(); }
});
