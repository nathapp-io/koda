import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { isRunnerPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { RagService } from './rag.service';
import { AddDocumentDto } from './dto/add-document.dto';
import type { KbCreator } from './kb-creator';

@Injectable()
export class KbDocumentAddition {
  constructor(
    private readonly rag: RagService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  async add(principal: KodaPrincipal, projectId: string, document: AddDocumentDto) {
    return (await this.prepare(principal, projectId, document))();
  }

  async prepare(principal: KodaPrincipal, projectId: string, document: AddDocumentDto) {
    if (isRunnerPrincipal(principal)) throw new ForbiddenAppException({}, 'permissions');
    const creator: KbCreator = { type: principal.actorType === 'user' ? 'USER' : 'AGENT', id: principal.id };
    const vector = await this.rag.embedForIndex(document.content);
    return async () => {
      if (vector === null) return { indexed: false, sourceId: document.sourceId };
      // Reread at execution, not preparation: ownership can change while an approval waits.
      const creators = await this.rag.findSourceCreators(projectId, document.source, document.sourceId);
      const replacesAnother = creators.some(row => row === null || row.type !== creator.type || row.id !== creator.id);
      if (replacesAnother && !(await this.permissions.can(principal, 'kb.document.delete', { projectId })).allowed) {
        throw new ForbiddenAppException({}, 'permissions');
      }
      // One shared VectorStore write; HybridRetriever reads the same table.
      const id = await this.rag.indexDocument(projectId, { ...document, metadata: document.metadata ?? {}, createdBy: creator }, vector);
      if (id === null) return { indexed: false, sourceId: document.sourceId };
      await this.audit.audited(async () => undefined, () => ({
        key: 'kb.document.add', resourceType: 'kb-document', resourceId: `${document.source}:${document.sourceId}`,
        projectId, summary: `added ${document.source} document`,
      }));
      return { indexed: true, id, sourceId: document.sourceId };
    };
  }
}
