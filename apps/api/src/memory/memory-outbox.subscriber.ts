import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExtractionService, MemoryExtractedItem } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { MemoryKind } from '../common/enums';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

@Injectable()
export class MemoryOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MemoryOutboxSubscriber.name);

  constructor(
    private readonly registry: OutboxFanOutRegistry,
    private readonly extractionService: ExtractionService,
    private readonly memoryRepository: PrismaMemoryItemRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register('ticket_event', this.handleTicketEvent.bind(this));
    this.registry.register('agent_event', this.handleAgentEvent.bind(this));
    this.logger.debug('Memory outbox handlers registered');
  }

  private async persistExtractedItems(items: MemoryExtractedItem[]): Promise<void> {
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
    const event = payload as { type: string; id: string; ticketId?: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'ticket_event' as const,
      timestamp: new Date(event.timestamp),
    });
    await this.persistExtractedItems(items);
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    const event = payload as { type: string; id: string; agentId: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    const items = this.extractionService.extractFromEvent({
      ...event,
      type: 'agent_event' as const,
      timestamp: new Date(event.timestamp),
    });
    await this.persistExtractedItems(items);
  }
}
