import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExtractionService, MemoryExtractedItem } from '../memory/extraction.service';
import { MemoryItemRepository, MemoryItemInput } from '../memory/memory-item-repository';
import { MemoryKind } from '../common/enums';

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
  {
    eventType: 'graphify_import',
    handler: async (payload: unknown) => {
      const p = payload as { projectId: string; nodeCount: number; linkCount: number };
      new Logger('OutboxFanOutRegistry').debug(`graphify_import: ${p.projectId}`);
    },
  },
];

@Injectable()
export class OutboxFanOutRegistry implements OnModuleInit {
  private readonly logger = new Logger(OutboxFanOutRegistry.name);
  private handlers: Map<string, Array<(payload: unknown) => void | Promise<void>>> = new Map();
  private lastDispatchFailureCount = 0;
  private extractionService: ExtractionService | null = null;
  private memoryRepository: MemoryItemRepository | null = null;

  constructor(
    extractionService?: ExtractionService,
    memoryRepository?: MemoryItemRepository,
  ) {
    this.extractionService = extractionService ?? null;
    this.memoryRepository = memoryRepository ?? null;

    for (const { eventType, handler } of DEFAULT_HANDLERS) {
      this.register(eventType, handler);
    }
    if (this.extractionService && this.memoryRepository) {
      this.register('ticket_event', this.handleTicketEvent.bind(this));
      this.register('agent_event', this.handleAgentEvent.bind(this));
    }
  }

  onModuleInit(): void {
    this.logger.log(`Registered ${DEFAULT_HANDLERS.length + (this.extractionService ? 2 : 0)} handlers`);
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

  register(eventType: string, handler: (payload: unknown) => void | Promise<void>): void {
    const existing = this.handlers.get(eventType) || [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
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