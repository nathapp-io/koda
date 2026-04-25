import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ExtractionService } from '../memory/extraction.service';
import { MemoryItemRepository } from '../memory/memory-item-repository';

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

  constructor(
    private readonly extractionService: ExtractionService,
    private readonly memoryRepository: MemoryItemRepository,
  ) {
    for (const { eventType, handler } of DEFAULT_HANDLERS) {
      this.register(eventType, handler);
    }
    this.register('ticket_event', this.handleTicketEvent.bind(this));
    this.register('agent_event', this.handleAgentEvent.bind(this));
  }

  onModuleInit(): void {
    this.logger.log(`Registered ${DEFAULT_HANDLERS.length + 2} handlers`);
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    const event = payload as { type: string; id: string; ticketId?: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    this.logger.debug(`handleTicketEvent called with payload: ${JSON.stringify(event)}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = this.extractionService.extractFromEvent(event as any);
    this.logger.debug(`Extraction returned ${items.length} items`);
    for (const item of items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.memoryRepository.upsert(item as any);
    }
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    const event = payload as { type: string; id: string; agentId: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = this.extractionService.extractFromEvent(event as any);
    for (const item of items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.memoryRepository.upsert(item as any);
    }
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
        console.error(`Handler for ${input.eventType} failed:`, error);
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
