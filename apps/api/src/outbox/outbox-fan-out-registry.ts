import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ExtractionService, MemoryExtractedItem } from '../memory/extraction.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { MemoryItemInput } from '../memory/memory-item-repository';
import { MemoryKind } from '../common/enums';
import { AstIndexService, SourceFile } from '../code-intel/ast-index.service';
import { CodeCommitOutboxHandler } from '../code-intel/code-commit-outbox-handler';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { WebhookDeliveryHandler } from '../webhook/webhook-delivery.handler';

export interface OutboxHandler {
  eventType: string;
  handler: (payload: unknown) => void | Promise<void>;
}

export const DEFAULT_HANDLERS: OutboxHandler[] = [
  {
    eventType: 'document_indexed',
    handler: async (payload: unknown) => {
      const p = payload as { sourceId: string; content: string; metadata: Record<string, unknown> };
      new Logger('OutboxFanOutRegistry').debug(`document_indexed: ${p.sourceId}`);
    },
  },
];

@Injectable()
export class OutboxFanOutRegistry implements OnModuleInit {
  private readonly logger = new Logger(OutboxFanOutRegistry.name);
  private handlers: Map<string, Array<(payload: unknown) => void | Promise<void>>> = new Map();
  private lastDispatchFailureCount = 0;
  private extractionService: ExtractionService | null = null;
  private memoryRepository: PrismaMemoryItemRepository | null = null;
  private astIndexService: AstIndexService | null = null;
  private codeCommitHandler: CodeCommitOutboxHandler | null = null;
  private webhookDeliveryHandler: WebhookDeliveryHandler | null = null;

  constructor(
    @Optional() extractionService?: ExtractionService,
    @Optional() memoryRepository?: PrismaMemoryItemRepository,
    @Optional() astIndexService?: AstIndexService,
    @Optional() codeCommitHandler?: CodeCommitOutboxHandler,
    @Optional() private readonly entityGraphService?: EntityGraphService,
    @Optional() webhookDeliveryHandler?: WebhookDeliveryHandler,
  ) {
    this.extractionService = extractionService ?? null;
    this.memoryRepository = memoryRepository ?? null;
    this.astIndexService = astIndexService ?? null;
    this.codeCommitHandler = codeCommitHandler ?? null;
    this.webhookDeliveryHandler = webhookDeliveryHandler ?? null;

    for (const { eventType, handler } of DEFAULT_HANDLERS) {
      this.register(eventType, handler);
    }
    if (this.extractionService && this.memoryRepository) {
      this.register('ticket_event', this.handleTicketEvent.bind(this));
      this.register('agent_event', this.handleAgentEvent.bind(this));
    }
    if (this.entityGraphService) {
      this.register('ticket_event', this.handleTicketEventForEntityGraph.bind(this));
      this.register('graphify_import', this.handleGraphifyImportForEntityGraph.bind(this));
    }
    if (this.codeCommitHandler || this.astIndexService) {
      this.register('code_commit', this.handleCodeCommit.bind(this));
    }
    if (this.webhookDeliveryHandler) {
      this.register('webhook_delivery', this.handleWebhookDelivery.bind(this));
    }
  }

  onModuleInit(): void {
    const extractionHandlers = this.extractionService && this.memoryRepository ? 2 : 0;
    const entityGraphHandlers = this.entityGraphService ? 2 : 0;
    const codeCommitHandlers = (this.codeCommitHandler || this.astIndexService) ? 1 : 0;
    this.logger.log(`Registered ${DEFAULT_HANDLERS.length + extractionHandlers + entityGraphHandlers + codeCommitHandlers} handlers`);
  }

  private async handleWebhookDelivery(payload: unknown): Promise<void> {
    if (!this.webhookDeliveryHandler) return;
    const p = payload as { webhookId: string; event: string; payload: unknown };
    await this.webhookDeliveryHandler.handle(p);
  }

  private async handleCodeCommit(payload: unknown): Promise<void> {
    const p = payload as Record<string, unknown>;
    const repoId = p.repoId as string | undefined;
    const commitHash = p.commitHash as string | undefined;
    const projectId = p.projectId as string | undefined;
    const webhookOnly = p.webhookOnly as boolean | undefined;
    const changedFiles = (p.changedFiles as SourceFile[] | undefined)
      ?? (p.files as SourceFile[] | undefined);

    if (this.codeCommitHandler) {
      this.logger.debug(`code_commit: delegating to CodeCommitOutboxHandler`);
      await this.codeCommitHandler.process(p);
      return;
    }

    if (webhookOnly) {
      this.logger.warn('code_commit: webhook payload requires CodeCommitOutboxHandler, but it is not registered');
      return;
    }

    if (!changedFiles || !Array.isArray(changedFiles) || changedFiles.length === 0) {
      this.logger.debug(`code_commit: no changed files provided`);
      return;
    }

    if (!repoId || !commitHash || !projectId) {
      this.logger.debug(`code_commit: missing required fields (repoId, commitHash, projectId)`);
      return;
    }

    if (!this.astIndexService) return;

    this.logger.log(`code_commit: indexing ${repoId} ${commitHash} (${changedFiles.length} files)`);
    await this.astIndexService.indexCommit(repoId, commitHash, changedFiles, projectId);
  }

  private async persistExtractedItems(items: MemoryExtractedItem[]): Promise<void> {
    if (!this.memoryRepository) return;
    for (const item of items) {
      const input: MemoryItemInput = {
        projectId: item.projectId,
        kind: item.kind as MemoryKind,
        subject: item.subject,
        predicate: item.predicate,
        object: item.object,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        confidence: item.confidence,
        ttlAt: item.ttlAt ?? null,
      };
      await this.memoryRepository.upsert(input);
    }
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    if (!this.extractionService) return;
    const event = payload as { type: string; id: string; ticketId?: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    this.logger.debug(`handleTicketEvent called with payload: ${JSON.stringify(event)}`);
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'ticket_event' as const,
      timestamp: new Date(event.timestamp),
    });
    this.logger.debug(`Extraction returned ${items.length} items`);
    await this.persistExtractedItems(items);
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    if (!this.extractionService) return;
    const event = payload as { type: string; id: string; agentId: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'agent_event' as const,
      timestamp: new Date(event.timestamp),
    });
    await this.persistExtractedItems(items);
  }

  private async handleTicketEventForEntityGraph(payload: unknown): Promise<void> {
    if (!this.entityGraphService) return;
    const p = payload as {
      type: string;
      id: string;
      ticketId?: string;
      projectId: string;
      actorId: string;
      action: string;
      data: Record<string, unknown>;
      timestamp: string;
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

  private async handleGraphifyImportForEntityGraph(payload: unknown): Promise<void> {
    if (!this.entityGraphService) return;
    const p = payload as {
      projectId: string;
      nodeCount?: number;
      linkCount?: number;
      nodes?: Array<{ nodeId: string; type: string; label: string; tags?: string[]; metadata?: Record<string, unknown> }>;
      links?: Array<{ sourceId: string; targetId: string; relation: string }>;
    };

    const nodes = (p.nodes ?? []).map((n) => ({
      nodeId: n.nodeId ?? n.nodeId,
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

  register(eventType: string, handler: (payload: unknown) => void | Promise<void>): void {
    const existing = this.handlers.get(eventType) || [];
    if (!existing.includes(handler)) {
      this.handlers.set(eventType, [...existing, handler]);
    }
  }

  unregister(eventType: string, handler: (payload: unknown) => void | Promise<void>): void {
    const existing = this.handlers.get(eventType) || [];
    const filtered = existing.filter((h) => h !== handler);
    if (filtered.length > 0) {
      this.handlers.set(eventType, filtered);
    } else {
      this.handlers.delete(eventType);
    }
  }

  async dispatch(input: { eventType: string; payload: unknown }): Promise<void> {
    this.lastDispatchFailureCount = 0;
    const handlers = this.handlers.get(input.eventType) || [];
    this.logger.debug(`Dispatching eventType=${input.eventType}, found ${handlers.length} handlers`);
    for (const handler of handlers) {
      try {
        await Promise.resolve(handler(input.payload));
      } catch (error) {
        this.logger.error(`Handler for ${input.eventType} failed`, error);
        this.lastDispatchFailureCount += 1;
      }
    }
  }

  getHandlers(eventType: string): Array<(payload: unknown) => void | Promise<void>> {
    return this.handlers.get(eventType) || [];
  }

  consumeLastDispatchFailureCount(): number {
    const failures = this.lastDispatchFailureCount;
    this.lastDispatchFailureCount = 0;
    return failures;
  }
}
