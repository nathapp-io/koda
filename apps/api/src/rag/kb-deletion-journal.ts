import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RAG_CFG, type IRagConfig } from '../config/rag.config';
import { currentContext, NO_APPROVAL, runWithActionContext, type ActionContext } from '../action-context/action-context';
import { AuditRecorder, type AuditRecordInput } from '../audit/audit-recorder.service';
import { RagService, type KbDocumentWriteSession } from './rag.service';
import { isSafeFilterValue } from './lance-table-manager';
import type { KbDeleteSource } from './dto/delete-kb-document.query';

interface SourceIntent {
  source: KbDeleteSource;
  ids: string[];
  audit: AuditRecordInput & { id: string };
}
interface DeleteIntent {
  version: 1;
  id: string;
  projectId: string;
  context: ActionContext;
  sources: SourceIntent[];
}
interface CommittedIntent { sequence: number; payload: string }

/** A failed COMMIT acknowledgment is not proof of abort. Recovery may still execute this id. */
export class KbDeletionCommitIndeterminateError extends AggregateError {
  readonly outcome = 'indeterminate';

  constructor(readonly intentId: string, errors: unknown[]) {
    super(errors, `KB deletion intent ${intentId} has an indeterminate commit outcome; recovery may complete deletion`);
    this.name = 'KbDeletionCommitIndeterminateError';
  }
}

/**
 * Only visible SQLite rows authorize recovery, never candidate payload files. COMMIT may
 * fail after journal removal: unless ROLLBACK succeeds, the caller must regard the outcome
 * as indeterminate, not aborted. Restart decides which intents survived; we neither promise
 * durability on an error nor try to cancel a possibly committed intent with fallible cleanup.
 * Stable audit ids protect against crash after the Postgres audit commit but before acknowledgment.
 */
@Injectable()
export class KbDeletionJournal implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KbDeletionJournal.name);
  private readonly directory: string;
  private database?: DatabaseSync;
  private recovering = false;
  private afterSequence = 0;
  private stopped = false;

  constructor(
    @Inject(RAG_CFG) config: IRagConfig,
    private readonly rag: RagService,
    private readonly audit: AuditRecorder,
  ) {
    this.directory = join(config.lancedbPath, 'kb-delete-journal');
  }

  async prepare(projectId: string, sourceId: string, sources: readonly KbDeleteSource[], session: KbDocumentWriteSession): Promise<DeleteIntent> {
    const entries: SourceIntent[] = [];
    for (const source of sources) {
      const ids = await session.findSourceRowIds(source, sourceId);
      if (ids.length === 0) continue;
      if (ids.some(id => !isSafeFilterValue(id))) throw new Error('Unsafe KB row id');
      entries.push({ source, ids, audit: {
        id: randomUUID(), key: 'kb.document.delete', resourceType: 'kb-document', resourceId: `${source}:${sourceId}`,
        projectId, summary: `deleted ${ids.length} ${source} rows`,
      } });
    }
    const intent: DeleteIntent = { version: 1, id: randomUUID(), projectId, sources: entries,
      context: structuredClone(currentContext() ?? { actor: { type: 'SYSTEM', id: 'unknown' }, origin: 'system', approval: NO_APPROVAL, correlationId: randomUUID() }),
    };
    if (entries.length > 0) this.persist(intent);
    return intent;
  }

  private ledger(): DatabaseSync {
    if (this.stopped) throw new Error('KB deletion journal is closed');
    if (this.database) return this.database;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Directory preparation is not commitment. If this fails there is no new ledger transaction.
    const parent = openSync(dirname(this.directory), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const database = new DatabaseSync(join(this.directory, 'committed.sqlite'));
    try {
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON');
      database.exec('CREATE TABLE IF NOT EXISTS intents (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)');
      this.database = database;
      return database;
    } catch (error) { database.close(); throw error; }
  }

  private persist(intent: DeleteIntent): void {
    const database = this.ledger();
    database.exec('BEGIN IMMEDIATE');
    let commitAttempted = false;
    try {
      database.prepare('INSERT INTO intents (id, payload) VALUES (?, ?)').run(intent.id, JSON.stringify(intent));
      // EXTRA syncs journal removal, but that sync can fail AFTER the transaction becomes visible.
      commitAttempted = true;
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); }
      catch (rollbackError) {
        if (commitAttempted) {
          const uncertain = new KbDeletionCommitIndeterminateError(intent.id, [error, rollbackError]);
          this.logger.error(uncertain.message);
          throw uncertain;
        }
        throw new AggregateError([error, rollbackError], 'KB deletion intent transaction failed');
      } finally {
        // Close rolls back only a still-active transaction, never an already-visible commit.
        // Keep any surviving intent for exact-id recovery, even when prepare reports uncertainty.
        this.database = undefined;
        database.close();
      }
      // Successful rollback proves this transaction did not commit.
      throw error;
    }
  }

  async onApplicationBootstrap(): Promise<void> { await this.recover(); }

  @Interval(30_000)
  async recover(): Promise<void> {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      const database = this.ledger();
      // Keyset pagination advances past failures, without retaining directory handles or names.
      const batch = database.prepare('SELECT sequence, payload FROM intents WHERE sequence > ? ORDER BY sequence LIMIT 100')
        .all(this.afterSequence) as unknown as CommittedIntent[];
      for (const row of batch) {
        if (this.stopped) break;
        this.afterSequence = row.sequence;
        try {
          const intent = this.parse(row.payload);
          await this.rag.withDocumentWriteLock(intent.projectId, async session => {
            for (const source of intent.sources) await session.deleteRows(source.ids);
            await runWithActionContext(intent.context, () => this.audit.audited(async () => undefined, () => intent.sources.map(source => source.audit)));
          }, { recovery: true });
          // The independent Postgres audit transaction has committed. Lost acknowledgments retry
          // this exact intent with the same audit ids; they never widen to replacement row ids.
          if (!this.stopped) database.prepare('DELETE FROM intents WHERE sequence = ?').run(row.sequence);
        } catch (error) {
          this.logger.error(`KB deletion recovery failed for receipt ${row.sequence}`, error instanceof Error ? error.stack : String(error));
        }
      }
      if (batch.length < 100) this.afterSequence = 0;
    } finally { this.recovering = false; }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.database?.close();
    this.database = undefined;
  }

  private parse(raw: string): DeleteIntent {
    const value = JSON.parse(raw) as DeleteIntent;
    if (value.version !== 1 || typeof value.id !== 'string' || typeof value.projectId !== 'string' || !value.projectId ||
      !value.context?.actor?.id || !value.context.correlationId || !value.context.approval || !Array.isArray(value.sources) || value.sources.length > 2 ||
      value.sources.some(source => !['doc', 'manual'].includes(source.source) || !Array.isArray(source.ids) ||
        source.ids.some(id => typeof id !== 'string' || !isSafeFilterValue(id)) || !source.audit?.id || source.audit.key !== 'kb.document.delete' || source.audit.projectId !== value.projectId)) {
      throw new Error('Invalid KB deletion journal receipt');
    }
    return value;
  }
}
