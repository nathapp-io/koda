import { Test } from '@nestjs/testing';
import { MemoryOutboxSubscriber } from './memory-outbox.subscriber';
import { ExtractionService } from './extraction.service';
import { PrismaMemoryItemRepository } from './prisma-memory-item.repository';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('MemoryOutboxSubscriber', () => {
  it('registers ticket_event and agent_event on init and persists extracted items', async () => {
    const registry = new OutboxFanOutRegistry();
    const extraction = {
      extractFromEvent: jest.fn().mockReturnValue([
        { projectId: 'p1', kind: 'fact', subject: 's', predicate: 'p', object: 'o', sourceType: 'ticket', sourceId: 't1', confidence: 1 },
      ]),
    } as unknown as ExtractionService;
    const repo = { upsert: jest.fn().mockResolvedValue(undefined) } as unknown as PrismaMemoryItemRepository;

    const subscriber = new MemoryOutboxSubscriber(registry, extraction, repo);
    subscriber.onModuleInit();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('agent_event').length).toBe(1);

    await registry.dispatch({
      eventType: 'ticket_event',
      payload: { type: 'ticket_event', id: 'e1', ticketId: 't1', projectId: 'p1', actorId: 'a1', action: 'created', data: {}, timestamp: new Date().toISOString() },
    });

    expect(extraction.extractFromEvent).toHaveBeenCalled();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
  });
});
