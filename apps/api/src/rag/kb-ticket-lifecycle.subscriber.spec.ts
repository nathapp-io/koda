import type { IRagConfig } from '../config/rag.config';
import { KbTicketLifecycleSubscriber } from './kb-ticket-lifecycle.subscriber';
import { VectorStore } from './vector-store.service';
import { RagService } from './rag.service';
import type { FanOutPublisher } from '../outbox/fan-out-publisher';
import type { PrismaRagRepository } from './prisma-rag.repository';

const liveProject = { id: 'proj-1', deletedAt: null };

function build(project: { id: string; deletedAt: Date | null } | null = liveProject) {
  const registry = { register: vi.fn() };
  const ragService = { deleteBySource: vi.fn().mockResolvedValue(undefined) };
  const ragRepository = { findProjectById: vi.fn().mockResolvedValue(project) };
  const subscriber = new KbTicketLifecycleSubscriber(
    registry as unknown as FanOutPublisher,
    ragService as unknown as RagService,
    ragRepository as unknown as PrismaRagRepository,
  );
  return { subscriber, registry, ragService, ragRepository };
}

const deleted = { id: 'ev-1', type: 'ticket_event', action: 'TICKET_DELETED', ticketId: 'tick-1', projectId: 'proj-1' };

describe('KbTicketLifecycleSubscriber', () => {
  it('registers on ticket_event', () => {
    const { subscriber, registry } = build();
    subscriber.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith('ticket_event', expect.any(Function));
  });

  it('deletes the ticket KB document on TICKET_DELETED', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent(deleted);
    expect(ragService.deleteBySource).toHaveBeenCalledWith('proj-1', 'tick-1');
  });

  it.each(['TICKET_CREATED', 'status_changed', 'assigned', 'COMMENT_ADDED'])('ignores %s', async (action) => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent({ ...deleted, action });
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('is idempotent: a relay retry runs the delete again without failing', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent(deleted);
    await subscriber.handleTicketEvent(deleted);
    expect(ragService.deleteBySource).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing', null],
    ['soft-deleted', { id: 'proj-1', deletedAt: new Date() }],
  ])('completes without deleting when the project is %s', async (_label, project) => {
    const { subscriber, ragService } = build(project);
    await expect(subscriber.handleTicketEvent(deleted)).resolves.toBeUndefined();
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('ignores a payload without ticketId or projectId', async () => {
    const { subscriber, ragService } = build();
    await subscriber.handleTicketEvent({ action: 'TICKET_DELETED' });
    expect(ragService.deleteBySource).not.toHaveBeenCalled();
  });

  it('handleTicketEvent removes the document through a real VectorStore', async () => {
    const ragConfig = { lancedbPath: './lancedb-kb-lifecycle-test', inMemoryOnly: true, ftsIndexMode: 'simple' } as IRagConfig;
    const embedding = { embed: vi.fn().mockResolvedValue(Array(8).fill(0.1)), providerName: 'fake', modelName: 'fake-v1', dimensions: 8 };
    const ragService = new RagService(new VectorStore(ragConfig, embedding as never));
    await ragService.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-1', content: 'closed ticket', metadata: {} });
    const subscriber = new KbTicketLifecycleSubscriber(
      { register: vi.fn() } as unknown as FanOutPublisher,
      ragService,
      { findProjectById: vi.fn().mockResolvedValue(liveProject) } as unknown as PrismaRagRepository,
    );

    await subscriber.handleTicketEvent(deleted);

    expect(await ragService.listDocuments('proj-1')).toEqual([]);
  });
});

describe('KB indexing is already an upsert (pin; fixed by H7, spec M15 bullet 2)', () => {
  it('re-indexing the same sourceId keeps one row', async () => {
    const ragConfig = { lancedbPath: './lancedb-kb-upsert-pin', inMemoryOnly: true, ftsIndexMode: 'simple' } as IRagConfig;
    const embedding = { embed: vi.fn().mockResolvedValue(Array(8).fill(0.1)), providerName: 'fake', modelName: 'fake-v1', dimensions: 8 };
    const store = new VectorStore(ragConfig, embedding as never);

    await store.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-9', content: 'v1', metadata: {} });
    await store.indexDocument('proj-1', { source: 'ticket', sourceId: 'tick-9', content: 'v2', metadata: {} });

    const docs = await store.listDocuments('proj-1');
    expect(docs.map((d) => d.content)).toEqual(['v2']);
  });
});
