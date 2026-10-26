import { SystemWriter } from '../permissions/system-writer.decorator';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { ExtractionService, MemoryExtractedItem } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { MemoryItemInput } from './memory-item-repository';
import { MemoryKind } from '../common/enums';
import { memoryAuditHook } from './memory-audit';
import { FanOutPublisher } from '../outbox/fan-out-publisher';

/**
 * The outbox extraction: every canonical event the outbox fans out turns into memory items of its project.
 *
 * Permissions P2 US-003: the fan-out runs each handler as `SYSTEM/outbox`, and this subscriber's own
 * `@SystemWriter('system.memory.extract-from-event')` names the component the extraction belongs to — `memory`.
 * Each handler therefore runs its body inside `runAsSystemWriter(this, …)`, so the item it writes and the entry it
 * records are the memory component's, while `runAsSystem` keeps the enclosing outbox record's correlation id: the
 * extraction and the delivery that triggered it stay joined. The entry is recorded through the upsert's `onWritten`,
 * so a refused one rolls that item back and the handler throws — the fan-out then marks the record failed and retries
 * it, as for any handler error.
 */
@Injectable()
@SystemWriter('system.memory.extract-from-event')
export class MemoryOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MemoryOutboxSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly extractionService: ExtractionService,
    private readonly memoryRepository: PrismaMemoryItemRepository,
    private readonly audit: AuditRecorder,
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
      await this.memoryRepository.upsert(input, {
        onWritten: memoryAuditHook(this.audit, 'system.memory.extract-from-event'),
      });
    }
  }

  private async handleTicketEvent(payload: unknown): Promise<void> {
    // Permissions P2 US-003: the body runs as this class's system component (`memory`), not as the outbox.
    await runAsSystemWriter(this, async () => {
      const event = payload as { type: string; id: string; ticketId?: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
      const items = this.extractionService.extractFromEvent({
        ...event,
        type: 'ticket_event' as const,
        timestamp: new Date(event.timestamp),
      });
      await this.persistExtractedItems(items);
    });
  }

  private async handleAgentEvent(payload: unknown): Promise<void> {
    await runAsSystemWriter(this, async () => {
      const event = payload as { type: string; id: string; agentId: string; projectId: string; actorId: string; action: string; data: unknown; timestamp: string };
      const items = this.extractionService.extractFromEvent({
        ...event,
        type: 'agent_event' as const,
        timestamp: new Date(event.timestamp),
      });
      await this.persistExtractedItems(items);
    });
  }
}
