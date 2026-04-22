import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';
import { RagService } from '../rag/rag.service';
import type {
  WriteResult,
  WriteTicketEventInput,
  WriteAgentActionInput,
  IndexDocumentInput,
  ImportGraphifyInput,
  Provenance,
} from './write-result.dto';

@Injectable()
export class KodaDomainWriter {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly ragService: RagService,
  ) {}

  private assertNonEmpty(value: string, field: string): void {
    if (!value || value.trim().length === 0) {
      throw new ValidationAppException({ [field]: `${field} is required` });
    }
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findUnique({ where: { id: projectId } });
    if (project === null) {
      throw new ForbiddenAppException({}, 'koda-domain-writer');
    }
  }

  private buildProvenance(
    actorId: string,
    projectId: string,
    action: string,
    source: 'api' | 'internal' | 'webhook',
  ): Provenance {
    return { actorId, projectId, action, timestamp: new Date(), source };
  }

  async writeTicketEvent(data: WriteTicketEventInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.ticketId, 'ticketId');
    this.assertNonEmpty(data.action, 'action');
    this.assertNonEmpty(data.actorId, 'actorId');

    await this.assertProjectExists(data.projectId);

    const event = await this.prisma.client.ticketEvent.create({
      data: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });

    return {
      canonicalId: event.id,
      provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source),
    };
  }

  async writeAgentAction(data: WriteAgentActionInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.agentId, 'agentId');

    await this.assertProjectExists(data.projectId);

    const event = await this.prisma.client.agentEvent.create({
      data: {
        agentId: data.agentId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });

    return {
      canonicalId: event.id,
      provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source),
    };
  }

  async indexDocument(data: IndexDocumentInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.sourceId, 'sourceId');
    this.assertNonEmpty(data.content, 'content');

    await this.assertProjectExists(data.projectId);

    let canonicalId: string | undefined;
    try {
      const event = await this.prisma.client.ticketEvent.create({
        data: {
          ticketId: data.sourceId,
          projectId: data.projectId,
          action: 'INDEX_DOCUMENT',
          actorId: data.actorId,
          actorType: 'agent',
          source: 'api',
          data: JSON.stringify({ source: data.source, metadata: data.metadata }),
          timestamp: data.timestamp ?? new Date(),
        },
      });
      canonicalId = event?.id;
    } catch {
      // Canonical write failure is surfaced via missing canonicalId; RAG error takes precedence in error field
    }

    let ragError: string | undefined;
    try {
      await this.ragService.indexDocument(data.projectId, {
        source: data.source,
        sourceId: data.sourceId,
        content: data.content,
        metadata: data.metadata,
      });
    } catch (err) {
      ragError = err instanceof Error ? err.message : String(err);
    }

    return {
      canonicalId,
      derivedIds: [],
      error: ragError,
      provenance: this.buildProvenance(data.actorId, data.projectId, 'INDEX_DOCUMENT', 'api'),
    };
  }

  async importGraphify(data: ImportGraphifyInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');

    await this.assertProjectExists(data.projectId);

    const result = await this.ragService.importGraphify(data.projectId, data.nodes, data.links);

    return {
      metadata: { imported: result.imported, cleared: result.cleared },
      provenance: this.buildProvenance(data.actorId, data.projectId, 'IMPORT_GRAPHIFY', 'api'),
    };
  }
}
