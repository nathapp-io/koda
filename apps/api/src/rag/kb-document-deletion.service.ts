import { KbDeletionJournal } from './kb-deletion-journal';
import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RagService } from './rag.service';
import { KB_DELETE_SOURCES, type KbDeleteSource } from './dto/delete-kb-document.query';

/** Shared by the immediate HTTP preflight and the deferred command's ownership recheck. */
@Injectable()
export class KbDocumentDeletion {
  constructor(
    private readonly rag: RagService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
    private readonly journal: KbDeletionJournal,
  ) {}

  /** Keep the same LanceDB -> Postgres lock order as addition, including deferred execution. */
  withExecution<T>(projectId: string, transaction: () => Promise<T>): Promise<T> {
    return this.rag.withDocumentWriteLock(projectId, () => transaction());
  }

  async preflight(principal: KodaPrincipal, projectId: string, sourceId: string, source?: KbDeleteSource) {
    const sources = source ? [source] : [...KB_DELETE_SOURCES];
    // These reads also preserve the store's filter-safe-id validation before any write.
    const creatorsBySource = await Promise.all(sources.map(source => this.rag.findSourceCreators(projectId, source, sourceId)));
    await Promise.all(creatorsBySource.flat().map(async createdBy => {
      const decision = await this.permissions.can(principal, 'kb.document.delete', { projectId, resource: { createdBy } });
      if (!decision.allowed) throw new ForbiddenAppException({}, 'permissions');
    }));
    return creatorsBySource;
  }

  async delete(principal: KodaPrincipal, projectId: string, sourceId: string, source?: KbDeleteSource): Promise<void> {
    await this.rag.withDocumentWriteLock(projectId, async session => {
      // Indexing uses this same mutex: no replacement can slip between the recheck and either delete.
      await this.preflight(principal, projectId, sourceId, source);
      const sources = source ? [source] : [...KB_DELETE_SOURCES];
      const intent = await this.journal.prepare(projectId, sourceId, sources, session);
      for (const source of sources) {
        await session.deleteBySource(source, sourceId);
        const entry = intent.sources.find(item => item.source === source)?.audit;
        if (entry) await this.audit.audited(async () => undefined, () => entry);
      }
      // Do not remove the receipt here: an enclosing approval transaction may still roll back.
      // The independent journal sweeper commits the idempotent audit before acknowledging it.
    });
  }
}
