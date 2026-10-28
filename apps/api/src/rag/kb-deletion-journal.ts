import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Dir } from 'node:fs';
import { dirname, join } from 'node:path';
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

/**
 * Write-ahead intents live beside LanceDB on its persistent volume. Once fsynced, an intent is
 * committed to deleting those immutable row ids, never a future replacement of the same source.
 * The audit insert uses a stable primary key. Receipts survive both audit failure and rollback of
 * an enclosing approval transaction; only an independent recovery transaction may remove them.
 */
@Injectable()
export class KbDeletionJournal implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KbDeletionJournal.name);
  private readonly directory: string;
  private recovering = false;
  private cursor?: Dir;
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

  private persist(intent: DeleteIntent): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Persist the directory entry as well on the first operation after installation.
    const parent = openSync(dirname(this.directory), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    const target = join(this.directory, `${intent.id}.json`);
    const temp = `${target}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(intent)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
    try {
      this.syncDirectory();
    } catch (error) {
      // The candidate was published but preparation never committed. Quarantine it before
      // reporting failure so neither this process nor a restarted sweeper can execute it.
      // Keep the failed preparation for diagnosis, not in the replayable .json namespace.
      try {
        renameSync(target, `${target}.aborted`);
        this.syncDirectory();
      } catch (abortError) {
        throw new AggregateError([error, abortError], 'KB deletion preparation could not be durably aborted');
      }
      throw error;
    }
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  async onApplicationBootstrap(): Promise<void> { await this.recover(); }

  @Interval(30_000)
  async recover(): Promise<void> {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.cursor ??= opendirSync(this.directory);
      // Continue this pass on the next tick, even when every attempted receipt fails. Never
      // read ahead beyond the batch: doing so would silently skip the 101st receipt.
      for (let scanned = 0; scanned < 100 && !this.stopped; scanned++) {
        const file = this.cursor.readSync();
        if (file === null) {
          this.closeCursor();
          break;
        }
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        try {
          const path = join(this.directory, file.name);
          const intent = this.parse(readFileSync(path, 'utf8'));
          await this.rag.withDocumentWriteLock(intent.projectId, async session => {
            for (const source of intent.sources) await session.deleteRows(source.ids);
            await runWithActionContext(intent.context, () => this.audit.audited(async () => undefined, () => intent.sources.map(source => source.audit)));
          }, { recovery: true });
          // audited() has committed here: this sweep has no enclosing request transaction.
          unlinkSync(path);
          this.syncDirectory();
        } catch (error) {
          this.logger.error(`KB deletion recovery failed for ${file.name}`, error instanceof Error ? error.stack : String(error));
        }
      }
    } catch (error) {
      this.closeCursor();
      throw error;
    } finally { this.recovering = false; }
  }

  private closeCursor(): void {
    const cursor = this.cursor;
    this.cursor = undefined;
    cursor?.closeSync();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    this.closeCursor();
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
