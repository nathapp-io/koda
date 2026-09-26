import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { RagService } from '../rag/rag.service';
import { AgentAuthProvider } from '../auth/agent-auth.provider';
import { TicketEventService } from '../events/ticket-event.service';
import { AgentEventService } from '../events/agent-event.service';
import { DecisionEventService } from '../events/decision-event.service';
import { buildTicketEventOutboxPayload, buildAgentEventOutboxPayload } from '../events/outbox-envelope.util';
import { PrismaKodaDomainWriterRepository } from './prisma-koda-domain-writer.repository';
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
    private readonly writerRepo: PrismaKodaDomainWriterRepository,
    private readonly ragService: RagService,
    private readonly outbox: NathappOutboxService,
    private readonly agentAuthProvider: AgentAuthProvider,
    private readonly ticketEventService: TicketEventService,
    private readonly agentEventService: AgentEventService,
    private readonly decisionEventService: DecisionEventService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  private assertNonEmpty(value: string, field: string): void {
    if (!value || value.trim().length === 0) {
      throw new ValidationAppException({ [field]: `${field} is required` });
    }
  }

  private async assertProjectExists(projectId: string): Promise<void> {
    const project = await this.writerRepo.findProjectById(projectId);
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

  private roleFromEventPayload(data: Record<string, unknown>): string | undefined {
    const actorRole = data['actorRole'];
    if (typeof actorRole === 'string' && actorRole.length > 0) {
      return actorRole;
    }
    const role = data['role'];
    if (typeof role === 'string' && role.length > 0) {
      return role;
    }
    return undefined;
  }

  async writeTicketEvent(data: WriteTicketEventInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.ticketId, 'ticketId');
    this.assertNonEmpty(data.action, 'action');
    this.assertNonEmpty(data.actorId, 'actorId');

    await this.assertProjectExists(data.projectId);

    const payloadRole = this.roleFromEventPayload(data.data ?? {});
    const projectRoles = data.actorType === 'agent'
      ? await this.agentAuthProvider.loadAgentRoles(data.actorId)
      : (payloadRole ? [payloadRole] : []);
    const actor = {
      actorType: data.actorType,
      actorId: data.actorId,
      projectRoles,
      resourceRoles: [],
    };
    this.assertActorHasEventRole(actor);

    return this.txManager.run(async () => {
      const event = await this.ticketEventService.create(data);
      await this.outbox.record({
        type: 'ticket_event',
        // H13: consumers switch on action/id/timestamp — record the full event envelope
        payload: buildTicketEventOutboxPayload({
          event,
          ticketId: data.ticketId,
          projectId: data.projectId,
          actorId: data.actorId,
          actorType: data.actorType,
          data: data.data,
        }),
        metadata: { projectId: data.projectId, eventId: event.id },
      });
      return {
        canonicalId: event.id,
        provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source, event.id),
      };
    });
  }

  async writeAgentAction(data: WriteAgentActionInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.agentId, 'agentId');

    await this.assertProjectExists(data.projectId);

    const actor = {
      actorType: 'agent' as const,
      actorId: data.agentId,
      projectRoles: await this.agentAuthProvider.loadAgentRoles(data.agentId),
      resourceRoles: [],
    };
    this.assertActorHasEventRole(actor);

    return this.txManager.run(async () => {
      const event = await this.agentEventService.create(data);
      await this.outbox.record({
        type: 'agent_event',
        // H13: consumers switch on action/id/timestamp — record the full event envelope
        payload: buildAgentEventOutboxPayload({
          event,
          agentId: data.agentId,
          projectId: data.projectId,
          actorId: data.actorId,
          data: data.data,
        }),
        metadata: { projectId: data.projectId, eventId: event.id },
      });
      return {
        canonicalId: event.id,
        provenance: this.buildProvenance(data.actorId, data.projectId, data.action, data.source, event.id),
      };
    });
  }

  async writeDecisionEvent(data: CreateDecisionEventInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.agentId, 'agentId');
    this.assertNonEmpty(data.action, 'action');

    await this.assertProjectExists(data.projectId);

    const actor = {
      actorType: 'agent' as const,
      actorId: data.agentId,
      projectRoles: await this.agentAuthProvider.loadAgentRoles(data.agentId),
      resourceRoles: [],
    };
    this.assertActorHasEventRole(actor);

    return this.txManager.run(async () => {
      const event = await this.decisionEventService.create(data);
      await this.outbox.record({
        type: 'decision_event',
        payload: {
          projectId: data.projectId,
          agentId: data.agentId,
          decision: data.decision,
          data: data.data,
        },
        metadata: { projectId: data.projectId, eventId: event.id },
      });
      return {
        canonicalId: event.id,
        provenance: this.buildProvenance(data.agentId, data.projectId, data.action, data.source, event.id),
      };
    });
  }

  async indexDocument(data: IndexDocumentInput): Promise<WriteResult> {
    this.assertNonEmpty(data.projectId, 'projectId');
    this.assertNonEmpty(data.sourceId, 'sourceId');
    this.assertNonEmpty(data.content, 'content');

    await this.assertProjectExists(data.projectId);

    if (data.source !== 'ticket') {
      throw new ValidationAppException({ source: 'source must be ticket for canonical indexing events' });
    }

    const event = await this.txManager.run(async () => {
      const created = await this.ticketEventService.create({
        ticketId: data.sourceId,
        projectId: data.projectId,
        action: 'INDEX_DOCUMENT',
        actorId: data.actorId,
        actorType: 'agent',
        source: 'api',
        data: { source: data.source, metadata: data.metadata },
      });
      await this.outbox.record({
        type: 'document_indexed',
        payload: {
          source: data.source,
          sourceId: data.sourceId,
          content: data.content,
          actorId: data.actorId,
          metadata: data.metadata,
        },
        metadata: { projectId: data.projectId, eventId: created.id },
      });
      return created;
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

    // The import spans the vector store and Prisma, which cannot share one Prisma
    // transaction; the event is recorded once the import has succeeded.
    await this.outbox.record({
      type: 'graphify_import',
      payload: { projectId: data.projectId, nodeCount: data.nodes.length, linkCount: data.links.length },
      metadata: { projectId: data.projectId, eventId: `${data.projectId}:${Date.now()}` },
    });

    return {
      metadata: { imported: result.imported, cleared: result.cleared },
      provenance: this.buildProvenance(data.actorId, data.projectId, 'IMPORT_GRAPHIFY', 'api'),
    };
  }
}
