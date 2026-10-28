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
  ) {}

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
    const creatorsBySource = await this.preflight(principal, projectId, sourceId, source);
    const sources = source ? [source] : [...KB_DELETE_SOURCES];
    for (const [index, source] of sources.entries()) {
      await this.rag.deleteBySource(projectId, source, sourceId);
      const creators = creatorsBySource[index] ?? [];
      if (creators.length > 0) {
        await this.audit.audited(async () => undefined, () => ({
          key: 'kb.document.delete', resourceType: 'kb-document', resourceId: `${source}:${sourceId}`,
          projectId, summary: `deleted ${creators.length} ${source} rows`,
        }));
      }
    }
  }
}
