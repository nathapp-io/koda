import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityGraphService } from './entity-graph.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class EntityGraphOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(EntityGraphOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly entityGraphService: EntityGraphService,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
    this.registry.register('graphify_import', this.handleGraphifyImport.bind(this));
    this.logger.debug('EntityGraph outbox handlers registered');
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    const p = payload as {
      type: string; id: string; ticketId?: string; projectId: string;
      actorId: string; action: string; data: Record<string, unknown>; timestamp: string;
    };
    await this.entityGraphService.onTicketEvent({
      type: 'ticket_event',
      id: p.id,
      ticketId: p.ticketId,
      projectId: p.projectId,
      actorId: p.actorId,
      action: p.action,
      data: p.data ?? {},
      timestamp: new Date(p.timestamp),
    });
  }

  private async handleGraphifyImport(payload: unknown): Promise<void> {
    const p = payload as {
      projectId: string;
      nodes?: Array<{ nodeId: string; type: string; label: string; tags?: string[]; metadata?: Record<string, unknown> }>;
      links?: Array<{ sourceId: string; targetId: string; relation: string }>;
    };
    const nodes = (p.nodes ?? []).map((n) => ({
      nodeId: n.nodeId,
      type: n.type,
      label: n.label,
      tags: n.tags,
      metadata: n.metadata,
    }));
    const links = (p.links ?? []).map((l) => ({
      sourceId: l.sourceId,
      targetId: l.targetId,
      relation: l.relation,
    }));
    await this.entityGraphService.onGraphifyImport(p.projectId, nodes, links);
  }
}
