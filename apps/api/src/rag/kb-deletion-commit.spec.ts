import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { KbDeletionJournal } from './kb-deletion-journal';
import { KbDocumentDeletion } from './kb-document-deletion.service';
import type { RagService, KbDocumentWriteSession } from './rag.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { PermissionService } from '../permissions/permission.service';
import type { AgentPrincipal } from '../auth/principal/koda-principal.types';
import type { IRagConfig } from '../config/rag.config';

const schema = 'CREATE TABLE IF NOT EXISTS intents (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)';
const payload = JSON.stringify({ version: 1, id: 'uncommitted', projectId: 'p1', context: { actor: { type: 'AGENT', id: 'a1' }, origin: 'rest', approval: { requiredMode: 'human', satisfiedBy: 'human', requestId: 'approval-1' }, correlationId: 'c1' }, sources: [{ source: 'doc', ids: ['old'], audit: { id: 'audit-1', key: 'kb.document.delete', resourceType: 'kb-document', resourceId: 'doc:s1', projectId: 'p1' } }] });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'koda-commit-'));
  const directory = join(root, 'kb-delete-journal');
  mkdirSync(directory);
  let rows = ['old'];
  const session: KbDocumentWriteSession = {
    findSourceRowIds: async () => [...rows],
    deleteBySource: async () => { rows = []; },
    deleteRows: async () => { rows = []; },
  };
  const rag = { findSourceCreators: async () => [{ type: 'AGENT', id: 'a1' }], withDocumentWriteLock: async (_project: string, fn: (session: KbDocumentWriteSession) => Promise<unknown>) => fn(session) } as unknown as RagService;
  const audit = { audited: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const journal = new KbDeletionJournal({ lancedbPath: root } as IRagConfig, rag, audit as unknown as AuditRecorder);
  return { root, directory, journal, rag, audit, rows: () => rows, restart: () => new KbDeletionJournal({ lancedbPath: root } as IRagConfig, rag, audit as unknown as AuditRecorder) };
}

it.each(['abort-rename-failed', 'abort-directory-fsync-failed'])('F4: restart never replays an uncommitted preparation left by %s', async () => {
  const f = fixture();
  // Crash image: a candidate .json survived, while its quarantine rename did not happen or was
  // not durable. Filename and a well-formed payload alone must never prove commitment.
  writeFileSync(join(f.directory, 'uncommitted.json'), payload);
  const restarted = f.restart();
  try {
    await restarted.recover();
    expect(f.rows()).toEqual(['old']);
    expect(f.audit.audited).not.toHaveBeenCalled();
  } finally { f.journal.onModuleDestroy(); restarted.onModuleDestroy(); rmSync(f.root, { recursive: true, force: true }); }
});

it('F4: a real failed COMMIT plus failed rollback cannot turn rejected preparation into a replayable intent', async () => {
  const f = fixture();
  const locker = new DatabaseSync(join(f.directory, 'committed.sqlite'));
  locker.exec(schema);
  // Rollback-journal SQLite permits the writer's INSERT but this reader prevents its COMMIT.
  locker.exec('BEGIN');
  locker.prepare('SELECT * FROM intents').all();
  const exec = DatabaseSync.prototype.exec;
  const failRollback = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
    return exec.call(this, sql);
  });
  const deletion = new KbDocumentDeletion(f.rag, { can: async () => ({ allowed: true }) } as unknown as PermissionService, f.audit as unknown as AuditRecorder, f.journal);
  try {
    const rejected = deletion.delete({ actorType: 'agent', id: 'a1' } as AgentPrincipal, 'p1', 's1', 'doc');
    await expect(rejected).rejects.toBeInstanceOf(AggregateError);
    await expect(rejected).rejects.toMatchObject({ errors: [expect.objectContaining({ errcode: 5 }), expect.objectContaining({ message: 'injected rollback failure' })] });
    expect(failRollback).toHaveBeenCalledWith('COMMIT');
    expect(failRollback).toHaveBeenCalledWith('ROLLBACK');
    expect(f.rows()).toEqual(['old']);
    expect(f.audit.audited).not.toHaveBeenCalled();
    failRollback.mockRestore();
    locker.exec('ROLLBACK');
    locker.close();
    f.journal.onModuleDestroy();
    const restarted = f.restart();
    try {
      await restarted.recover();
      expect(f.rows()).toEqual(['old']);
      expect(f.audit.audited).not.toHaveBeenCalled();
      const verify = new DatabaseSync(join(f.directory, 'committed.sqlite'));
      try { expect(verify.prepare('SELECT count(*) AS count FROM intents').get()).toMatchObject({ count: 0 }); }
      finally { verify.close(); }
    } finally { restarted.onModuleDestroy(); }
  } finally {
    failRollback.mockRestore();
    if (locker.isOpen) locker.close();
    f.journal.onModuleDestroy();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it.each([false, true])('F4: crash recovery distinguishes uncommitted from committed intent (committed=%s)', async committed => {
  const f = fixture();
  const path = join(f.directory, 'committed.sqlite');
  const db = new DatabaseSync(path);
  db.exec(schema); db.close();
  const child = spawnSync(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE');
    const receipt = JSON.parse(process.argv[2]);
    receipt.padding = 'x'.repeat(256 * 1024);
    db.prepare('INSERT INTO intents (id, payload) VALUES (?, ?)').run('uncommitted', JSON.stringify(receipt));
    if (process.argv[3] === 'true') db.exec('COMMIT');
    else if (!require('node:fs').existsSync(process.argv[1] + '-journal')) process.exit(18);
    // Do not run DatabaseSync.close, JS cleanup, or native process-exit hooks.
    process.kill(process.pid, 'SIGKILL');
  `, path, payload, String(committed)], { encoding: 'utf8' });
  const restarted = f.restart();
  try {
    expect(child.error).toBeUndefined();
    expect(child.status).toBeNull();
    expect(child.signal).toBe('SIGKILL');
    await restarted.recover();
    expect(f.rows()).toEqual(committed ? [] : ['old']);
    expect(f.audit.audited).toHaveBeenCalledTimes(committed ? 1 : 0);
    const verify = new DatabaseSync(path);
    try { expect(verify.prepare('SELECT count(*) AS count FROM intents').get()).toMatchObject({ count: 0 }); }
    finally { verify.close(); }
  } finally { restarted.onModuleDestroy(); f.journal.onModuleDestroy(); rmSync(f.root, { recursive: true, force: true }); }
});
