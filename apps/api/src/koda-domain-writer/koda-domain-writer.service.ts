import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';
import { RagService } from '../rag/rag.service';
import { OutboxService } from '../outbox/outbox.service';
import { ActorResolver, ActorRequest } from '../events/actor-resolver.service';
import { TicketEventService } from '../events/ticket-event.service';
import { AgentEventService } from '../events/agent-event.service';
import { DecisionEventService } from '../events/decision-event.service';
import type {
  WriteResult,
  WriteTicketEventInput,
  WriteAgentActionInput,
  CreateDecisionEventInput,
  IndexDocumentInput,
  ImportGraphifyInput,
  Provenance,
} from './write-result.dto';

@Injectable()
export class KodaDomainWriter {
  constructor(
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly ragService: RagService,
    private readonly outboxService: OutboxService,
    private readonly actorResolver: ActorResolver,
    private readonly ticketEventService: TicketEventService,
    private readonly agentEventService: AgentEventService,
    private readonly decisionEventService: DecisionEventService,
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
    eventId?: string,
  ): Provenance {
    return { actorId, projectId, action, timestamp: new Date(), source, eventId };
  }

  private assertActorHasEventRole(actor: { actorType: 'user' | 'agent'; projectRoles: string[] }): void {
    if (actor.projectRoles.length === 0) {
      if (actor.actorType === 'agent') {
        return;
      }
      throw new ForbiddenAppException({}, 'koda-domain-writer');
    }
    const allowedRoles = ['ADMIN', 'DEVELOPER', 'REVIEWER', 'TRIAGER', 'AGENT'];
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

    const mockRequest: ActorRequest = {
      user: data.actorType === 'user' ? { id: data.actorId, sub: data.actorId } : null,
      agent: data.actorType === 'agent' ? { id: data.actorId, sub: data.actorId } : null,
    };
    const actor = await this.actorResolver.resolve(mockRequest);
    this.assertActorHasEventRole(actor);

    const event = await this.ticketEventService.create(data);

    await this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'ticket_event',
      eventId: event.id,
      payload: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        actorId: data.actorId,
        data: data.data,
      },
    });

    return {
      canonicalId: event.id,
      provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source, event.id),
    };
  }

  async writeAgentAction(data: WriteAgentActionInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.agentId, 'agentId');

    const mockRequest: ActorRequest = {
      user: null,
      agent: { id: data.agentId, sub: data.agentId },
    };
    const actor = await this.actorResolver.resolve(mockRequest);
    this.assertActorHasEventRole(actor);

    const event = await this.agentEventService.create(data);

    await this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'agent_event',
      eventId: event.id,
      payload: {
        agentId: data.agentId,
        projectId: data.projectId,
        actorId: data.actorId,
        data: data.data,
      },
    });

    return {
      canonicalId: event.id,
      provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source, event.id),
    };
  }

  async writeDecisionEvent(data: CreateDecisionEventInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.agentId, 'agentId');
    this.assertNonEmpty(data.action, 'action');

    const mockRequest: ActorRequest = {
      user: null,
      agent: { id: data.agentId, sub: data.agentId },
    };
    const actor = await this.actorResolver.resolve(mockRequest);
    this.assertActorHasEventRole(actor);

    const event = await this.decisionEventService.create(data);

    await this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'decision_event',
      eventId: event.id,
      payload: {
        projectId: data.projectId,
        agentId: data.agentId,
        decision: data.decision,
        data: data.data,
      },
    });

    return {
      canonicalId: event.id,
      provenance: this.buildProvenance(data.agentId, data.projectId, data.action, data.source, event.id),
    };
  }

  async indexDocument(data: IndexDocumentInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.sourceId, 'sourceId');
    this.assertNonEmpty(data.content, 'content');

    if (data.source !== 'ticket') {
      throw new ValidationAppException({ source: 'source must be ticket for canonical indexing events' });
    }

    const event = await this.ticketEventService.create({
      ticketId: data.sourceId,
      projectId: data.projectId,
      action: 'INDEX_DOCUMENT',
      actorId: data.actorId,
      actorType: 'agent',
      source: 'api',
      data: { source: data.source, metadata: data.metadata },
    });

    await this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'document_indexed',
      eventId: event.id,
      payload: {
        source: data.source,
        sourceId: data.sourceId,
        content: data.content,
        actorId: data.actorId,
        metadata: data.metadata,
      },
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
      provenance: this.buildProvenance(data.actorId, data.projectId, 'INDEX_DOCUMENT', 'api', event.id),
    };
  }

  async importGraphify(data: ImportGraphifyInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');

    await this.assertProjectExists(data.projectId);

    const result = await this.ragService.importGraphify(data.projectId, data.nodes, data.links);

    await this.outboxService.enqueue({
      projectId: data.projectId,
      eventType: 'graphify_import',
      eventId: `${data.projectId}:${Date.now()}`,
      payload: {
        projectId: data.projectId,
        nodeCount: data.nodes.length,
        linkCount: data.links.length,
      },
    });

    return {
      metadata: { imported: result.imported, cleared: result.cleared },
      provenance: this.buildProvenance(data.actorId, data.projectId, 'IMPORT_GRAPHIFY', 'api'),
    };
  }
}
