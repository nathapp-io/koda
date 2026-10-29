import { DatabaseSync } from 'node:sqlite';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KbAdditionJournal } from './kb-addition-journal';
import type { IRagConfig } from '../config/rag.config';
import type { RagService, KbDocumentWriteSession } from './rag.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { PrismaRagRepository } from './prisma-rag.repository';

const root = mkdtempSync(join(tmpdir(), 'koda-add-undo-'));
let directory: string;
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('KbAdditionJournal durable undo', () => {
  let journal: KbAdditionJournal;
  let committed: boolean;
  const txManager = { isInTransaction: vi.fn() };
  const session = { capturePair: vi.fn(), restorePair: vi.fn() };
  const rag = { withDocumentWriteLock: vi.fn(), blockDocumentWrites: vi.fn() };
  const repository = { lockAdditionIntent: vi.fn(), withAdditionCommitProof: vi.fn() };
  const audit = { audited: vi.fn() };
  beforeEach(() => {
    directory = mkdtempSync(join(root, 'case-'));
    vi.resetAllMocks(); committed = false;
    txManager.isInTransaction.mockReturnValue(false);
    session.capturePair.mockResolvedValue([{ id: 'old', source: 'manual', source_id: 's1', content: 'original', vector: [1], metadata: '{}', created_at: '2026-01-01', provider: 'fake', model: 'fake' }]);
    session.restorePair.mockResolvedValue(undefined);
    rag.withDocumentWriteLock.mockImplementation(async (_id, work) => work(session));
    repository.lockAdditionIntent.mockResolvedValue(undefined);
    repository.withAdditionCommitProof.mockImplementation(async (_id, work) => work(committed));
    audit.audited.mockImplementation(async work => work());
    journal = makeJournal();
  });
  afterEach(() => { journal.onModuleDestroy(); rmSync(directory, { recursive: true, force: true }); });
  function makeJournal() {
    return new KbAdditionJournal({ lancedbPath: directory } as IRagConfig, rag as unknown as RagService, audit as unknown as AuditRecorder, repository as unknown as PrismaRagRepository, txManager as unknown as ITransactionManager);
  }
  const stage = () => journal.prepare('p1', 'manual', 's1', session as unknown as KbDocumentWriteSession);
  it('refuses an unowned ambient transaction before touching the store', async () => {
    txManager.isInTransaction.mockReturnValue(true);
    const work = vi.fn();
    await expect(journal.withExecution('p1', work)).rejects.toThrow('transaction');
    expect(work).not.toHaveBeenCalled();
    expect(rag.withDocumentWriteLock).not.toHaveBeenCalled();
  });
  it('F3: restores the exact snapshot after the enclosing transaction rejects', async () => {
    await expect(journal.withExecution('p1', async () => { await stage(); throw new Error('commit failed'); })).rejects.toThrow('commit failed');
    expect(session.restorePair).toHaveBeenCalledWith('manual', 's1', expect.arrayContaining([expect.objectContaining({ id: 'old', content: 'original' })]));
  });
  it('F3: a lost commit acknowledgment keeps the replacement if its audit committed', async () => {
    committed = true;
    await expect(journal.withExecution('p1', async () => { await stage(); throw new Error('ack lost'); })).rejects.toThrow('ack lost');
    expect(session.restorePair).not.toHaveBeenCalled();
  });
  it('F3: failed compensation fences writers and survives journal restart', async () => {
    session.restorePair.mockRejectedValue(new Error('store unavailable'));
    await expect(journal.withExecution('p1', async () => { await stage(); throw new Error('rollback'); })).rejects.toThrow();
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
    journal.onModuleDestroy();
    journal = makeJournal();
    journal.onModuleInit();
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
    session.restorePair.mockResolvedValue(undefined);
    await journal.recover();
    expect(session.restorePair).toHaveBeenLastCalledWith('manual', 's1', expect.arrayContaining([expect.objectContaining({ id: 'old' })]));
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', false);
    session.restorePair.mockClear();
    await journal.recover();
    expect(session.restorePair).not.toHaveBeenCalled();
  });
  it('runs immediate work in one owned audit transaction and joins its session', async () => {
    const result = await journal.run('p1', async held => {
      expect(held).toBe(session);
      await stage(); committed = true;
      return 'done';
    });
    expect(result).toBe('done');
    expect(audit.audited).toHaveBeenCalledTimes(1);
    expect(repository.lockAdditionIntent).toHaveBeenCalledTimes(1);
    expect(session.restorePair).not.toHaveBeenCalled();
  });
  it('does not compensate when work fails before any intent was written', async () => {
    await expect(journal.withExecution('p1', async () => { throw new Error('forbidden'); })).rejects.toThrow('forbidden');
    expect(repository.withAdditionCommitProof).not.toHaveBeenCalled();
    expect(session.restorePair).not.toHaveBeenCalled();
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', false);
  });
  it('refuses nested execution boundaries and mismatched project sessions', async () => {
    await journal.withExecution('p1', async () => {
      await expect(journal.withExecution('p1', async () => undefined)).rejects.toThrow('Nested');
      await expect(journal.run('p2', async () => undefined)).rejects.toThrow('mismatch');
    });
  });
  it('does not write an intent if reading the snapshot fails', async () => {
    session.capturePair.mockRejectedValue(new Error('snapshot read failure'));
    await expect(journal.withExecution('p1', stage)).rejects.toThrow('snapshot read failure');
    expect(session.restorePair).not.toHaveBeenCalled();
  });
  it('keeps the receipt fenced when Postgres commit proof is unavailable', async () => {
    repository.withAdditionCommitProof.mockRejectedValue(new Error('PG unavailable'));
    await expect(journal.withExecution('p1', stage)).rejects.toThrow('PG unavailable');
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
    expect(session.restorePair).not.toHaveBeenCalled();
    repository.withAdditionCommitProof.mockImplementation(async (_id, work) => work(false));
    await journal.recover();
    expect(session.restorePair).toHaveBeenCalledTimes(1);
    expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', false);
  });
  it('replays a lost acknowledgment after a committed audit without undoing the row', async () => {
    committed = true;
    let external: DatabaseSync | undefined;
    try {
      await expect(journal.withExecution('p1', async () => {
        await stage();
        external = new DatabaseSync(join(directory, 'kb-add-undo/committed.sqlite'));
        external.exec("CREATE TRIGGER fail_ack BEFORE DELETE ON intents BEGIN SELECT RAISE(ABORT, 'lost acknowledgment'); END");
      })).rejects.toThrow('lost acknowledgment');
      expect(session.restorePair).not.toHaveBeenCalled();
      expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
      journal.onModuleDestroy();
      external?.exec('DROP TRIGGER fail_ack');
      journal = makeJournal(); journal.onModuleInit();
      await journal.recover();
      expect(session.restorePair).not.toHaveBeenCalled();
      expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', false);
    } finally { external?.close(); }
  });
  it('fails closed on a corrupt receipt without widening a restoration', async () => {
    await journal.withExecution('p1', async () => undefined);
    const db = new DatabaseSync(join(directory, 'kb-add-undo/committed.sqlite'));
    try {
      db.prepare('INSERT INTO intents VALUES (?, ?, ?)').run('corrupt', 'p1', JSON.stringify({ version: 9 }));
      await journal.recover();
      expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
      expect(session.restorePair).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it('bounds a project recovery batch and retains its fence on overflow', async () => {
    await journal.withExecution('p1', async () => undefined);
    const db = new DatabaseSync(join(directory, 'kb-add-undo/committed.sqlite'));
    try {
      const insert = db.prepare('INSERT INTO intents VALUES (?, ?, ?)');
      for (let i = 0; i < 101; i++) insert.run(`id-${i}`, 'p1', '{}');
      await journal.recover();
      expect(rag.blockDocumentWrites).toHaveBeenLastCalledWith('p1', true);
      expect(session.restorePair).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it('initializes and sweeps an unused store without creating directories', async () => {
    journal.onModuleInit();
    await journal.recover();
    expect(existsSync(join(directory, 'kb-add-undo'))).toBe(false);
    expect(rag.withDocumentWriteLock).not.toHaveBeenCalled();
  });
  it('does not reopen a stopped journal during its sweeper', async () => {
    journal.onModuleDestroy();
    await journal.recover();
    expect(rag.withDocumentWriteLock).not.toHaveBeenCalled();
  });

});
