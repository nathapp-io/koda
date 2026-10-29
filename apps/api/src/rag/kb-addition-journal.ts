import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable, Logger, type OnModuleInit, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RAG_CFG, type IRagConfig } from '../config/rag.config';
import { AuditRecorder, type AuditRecordInput } from '../audit/audit-recorder.service';
import { RagService, type KbDocumentWriteSession } from './rag.service';
import { PrismaRagRepository } from './prisma-rag.repository';
import { isSafeFilterValue, type LanceRecord } from './lance-table-manager';

interface UndoIntent {
  version: 1;
  id: string;
  projectId: string;
  source: string;
  sourceId: string;
  before: LanceRecord[];
}

/**
 * Write-ahead undo for the non-transactional KB store. The table lock encloses the ENTIRE
 * Postgres transaction, including audit and approval settlement, not just the command callback.
 * A stable audit id is the commit witness: it commits in the same transaction as settlement.
 * Recovery takes the intent's PG advisory lock before checking that witness, so a lost COMMIT
 * acknowledgment cannot be mistaken for rollback while the server is still committing.
 * Unresolved receipts fence all table writers; no later row can be clobbered by compensation.
 */
@Injectable()
export class KbAdditionJournal implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KbAdditionJournal.name);
  private readonly directory: string;
  private database?: DatabaseSync;
  private stopped = false;
  private recovering = false;
  private readonly scope = new AsyncLocalStorage<{ projectId: string; session: KbDocumentWriteSession }>();

  constructor(
    @Inject(RAG_CFG) config: IRagConfig,
    private readonly rag: RagService,
    private readonly audit: AuditRecorder,
    private readonly repository: PrismaRagRepository,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) { this.directory = join(config.lancedbPath, 'kb-add-undo'); }

  /** Called outside the execution transaction; keeps its shared table lock through commit/rollback. */
  async withExecution<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) throw new Error('Nested KB addition execution boundary');
    if (this.txManager.isInTransaction()) throw new Error('KB addition boundary must enclose the owning transaction');
    return this.rag.withDocumentWriteLock(projectId, async session => {
      await this.resolveProject(projectId, session);
      try {
        return await this.scope.run({ projectId, session }, work);
      } finally {
        // Runs outside the transaction owner's run(), including on commit/settlement failure.
        await this.resolveProject(projectId, session);
      }
    }, { recovery: true, additionRecovery: true });
  }

  /** Direct/immediate calls own an audit transaction; deferred callbacks join the engine's. */
  async run<T>(projectId: string, work: (session: KbDocumentWriteSession) => Promise<T>): Promise<T> {
    const current = this.scope.getStore();
    if (current) {
      if (current.projectId !== projectId) throw new Error('KB addition project boundary mismatch');
      return work(current.session);
    }
    return this.withExecution(projectId, () => this.audit.audited(() => this.run(projectId, work), () => []));
  }

  async prepare(projectId: string, source: string, sourceId: string, session: KbDocumentWriteSession): Promise<AuditRecordInput & { id: string }> {
    const id = randomUUID();
    // Joins the mutating transaction; a resolver must wait for this owner to finish.
    await this.repository.lockAdditionIntent(id);
    const intent: UndoIntent = { version: 1, id, projectId, source, sourceId, before: await session.capturePair(source, sourceId) };
    const payload = JSON.stringify(intent);
    this.parse(payload); // refuse an unrestorable snapshot before any LanceDB mutation
    this.rag.blockDocumentWrites(projectId, true);
    const db = this.ledger();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO intents (id, projectId, payload) VALUES (?, ?, ?)').run(id, projectId, payload);
      db.exec('COMMIT');
    } catch (error) {
      // A failed acknowledgment may still have committed. Never mutate LanceDB on this path;
      // the surviving ledger rows (if any) are resolved under the same table lock in finally.
      try { db.exec('ROLLBACK'); } catch { this.database = undefined; db.close(); }
      throw error;
    }
    return { id, key: 'kb.document.add', resourceType: 'kb-document', resourceId: `${source}:${sourceId}`, projectId, summary: `added ${source} document` };
  }

  private async resolveProject(projectId: string, session: KbDocumentWriteSession): Promise<void> {
    try {
      const db = this.ledger();
      const rows = db.prepare('SELECT id, payload FROM intents WHERE projectId = ? ORDER BY rowid LIMIT 101').all(projectId) as unknown as Array<{ id: string; payload: string }>;
      if (rows.length > 100) throw new Error('Too many unresolved KB additions for one project');
      for (const row of rows) {
        const intent = this.parse(row.payload);
        if (intent.id !== row.id || intent.projectId !== projectId) throw new Error('KB addition receipt identity mismatch');
        await this.repository.withAdditionCommitProof(intent.id, async committed => {
          if (!committed) await session.restorePair(intent.source, intent.sourceId, intent.before);
        });
        db.prepare('DELETE FROM intents WHERE id = ?').run(intent.id);
      }
      this.rag.blockDocumentWrites(projectId, false);
    } catch (error) {
      this.rag.blockDocumentWrites(projectId, true);
      throw error;
    }
  }

  onModuleInit(): void {
    // Fence leftovers before bootstrap/startup writers can reach the shared manager.
    for (const projectId of this.pendingProjects()) this.rag.blockDocumentWrites(projectId, true);
  }

  async onApplicationBootstrap(): Promise<void> { await this.recover(); }

  @Interval(30_000)
  async recover(): Promise<void> {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    try {
      for (const projectId of this.pendingProjects()) {
        try {
          await this.rag.withDocumentWriteLock(projectId, session => this.resolveProject(projectId, session), { recovery: true, additionRecovery: true });
        } catch (error) {
          this.logger.error(`KB addition recovery failed for project ${projectId}`, error instanceof Error ? error.stack : String(error));
        }
      }
    } finally { this.recovering = false; }
  }

  private pendingProjects(): string[] {
    // An unused store has nothing to recover. In particular DI-only init must not create files.
    if (!this.database) {
      try { statSync(join(this.directory, 'committed.sqlite')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error; // unreadable is not evidence of an empty journal
      }
    }
    const rows = this.ledger().prepare('SELECT DISTINCT projectId FROM intents LIMIT 1001').all() as unknown as Array<{ projectId: string }>;
    if (rows.length > 1000) throw new Error('KB addition recovery project limit exceeded');
    return rows.map(row => row.projectId);
  }

  private ledger(): DatabaseSync {
    if (this.stopped) throw new Error('KB addition journal is closed');
    if (this.database) return this.database;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const parent = openSync(dirname(this.directory), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const db = new DatabaseSync(join(this.directory, 'committed.sqlite'));
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON');
      db.exec('CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, payload TEXT NOT NULL)');
      db.exec('CREATE INDEX IF NOT EXISTS intent_project ON intents(projectId)');
      this.database = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  private parse(raw: string): UndoIntent {
    const intent = JSON.parse(raw) as UndoIntent;
    if (intent.version !== 1 || typeof intent.id !== 'string' || typeof intent.projectId !== 'string' || !intent.projectId ||
      !['doc', 'manual'].includes(intent.source) || typeof intent.sourceId !== 'string' || !isSafeFilterValue(intent.sourceId) || !Array.isArray(intent.before) ||
      intent.before.some(row => !row || typeof row.id !== 'string' || !isSafeFilterValue(row.id) || row.source !== intent.source || row.source_id !== intent.sourceId ||
        typeof row.content !== 'string' || typeof row.metadata !== 'string' || typeof row.created_at !== 'string' ||
        typeof row.provider !== 'string' || typeof row.model !== 'string' || !Array.isArray(row.vector) || !row.vector.every(Number.isFinite))) {
      throw new Error('Invalid KB addition undo receipt');
    }
    return intent;
  }

  onModuleDestroy(): void { this.stopped = true; this.database?.close(); this.database = undefined; }
}
