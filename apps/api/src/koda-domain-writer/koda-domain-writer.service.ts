import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';
import { RagService } from '../rag/rag.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActorResolver, ActorRequest } from '../events/actor-resolver.service';
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
  private readonly logger = new Logger(KodaDomainWriter.name);

  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly ragService: RagService,
    private readonly outboxService: OutboxService,
    private readonly actorResolver: ActorResolver,
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

  private assertActorHasEventRole(actor: { projectRoles: string[] }): void {
    if (actor.projectRoles.length === 0) {
      return;
    }
    const allowedRoles = ['ADMIN', 'DEVELOPER', 'AGENT'];
    const hasRole = actor.projectRoles.some((role) => allowedRoles.includes(role));
    if (!hasRole) {
      throw new ForbiddenAppException({}, 'koda-domain-writer');
    }
  }

  async writeTicketEvent(data: WriteTicketEventInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.ticketId, 'ticketId');
    this.assertNonEmpty(data.action, 'action');
    this.assertNonEmpty(data.actorId, 'actorId');

    await this.assertProjectExists(data.projectId);

    const mockRequest: ActorRequest = {
      user: data.actorType === 'user' ? { id: data.actorId, sub: data.actorId } : null,
      agent: data.actorType === 'agent' ? { id: data.actorId, sub: data.actorId } : null,
    };
    const actor = await this.actorResolver.resolve(mockRequest);
    this.assertActorHasEventRole(actor);

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

    // Fire-and-forget: enqueue outbox event for follow-up work
    this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'ticket_event',
      eventId: event.id,
      payload: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        actorId: data.actorId,
        data: data.data,
      },
    }).catch(err => {
      // Log but don't block the canonical write
      this.logger.error(`Failed to enqueue outbox event for ticket ${event.id}: ${String(err)}`);
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

    const mockRequest: ActorRequest = {
      user: null,
      agent: { id: data.agentId, sub: data.agentId },
    };
    const actor = await this.actorResolver.resolve(mockRequest);
    this.assertActorHasEventRole(actor);

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

    // Fire-and-forget: enqueue outbox event for follow-up work
    this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'agent_event',
      eventId: event.id,
      payload: {
        agentId: data.agentId,
        projectId: data.projectId,
        actorId: data.actorId,
        data: data.data,
      },
    }).catch(err => {
      // Log but don't block the canonical write
      this.logger.error(`Failed to enqueue outbox event for agent ${event.id}: ${String(err)}`);
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

    if (data.source !== 'ticket') {
      throw new ValidationAppException({ source: 'source must be ticket for canonical indexing events' });
    }

    await this.assertProjectExists(data.projectId);

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

    // Fire-and-forget: canonical write succeeded, queue derived indexing follow-up
    this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'document_indexed',
      eventId: event.id,
      payload: {
        source: data.source,
        sourceId: data.sourceId,
        actorId: data.actorId,
        metadata: data.metadata,
      },
    }).catch(err => {
      this.logger.error(`Failed to enqueue document_indexed outbox event ${event.id}: ${String(err)}`);
    });

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
      canonicalId: event.id,
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
