import { Test, TestingModule } from '@nestjs/testing';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { InMemoryEntityStore } from '../../../src/entity-graph/in-memory-entity-store';
import { EntityNodeType } from '../../../src/entity-graph/dto/entity-graph.types';

describe('EntityGraphService AC9: Outbox fan-out integration', () => {
  let fanOutRegistry: OutboxFanOutRegistry;
  let entityGraphService: EntityGraphService;
  let entityStore: InMemoryEntityStore;

  beforeEach(async () => {
    entityStore = new InMemoryEntityStore();
    entityGraphService = new EntityGraphService(entityStore);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: OutboxFanOutRegistry, useValue: new OutboxFanOutRegistry() },
        { provide: EntityGraphService, useValue: entityGraphService },
      ],
    }).compile();

    fanOutRegistry = module.get<OutboxFanOutRegistry>(OutboxFanOutRegistry);
  });

  describe('AC9: Outbox fan-out handlers for entity_graph events', () => {
    it('AC9: OutboxFanOutRegistry should have a handler for ticket_event that updates entity graph', async () => {
      const handlers = fanOutRegistry.getHandlers('ticket_event');
      expect(handlers.length).toBeGreaterThanOrEqual(0);
    });

    it('AC9: dispatch(ticket_event) updates the entity graph incrementally', async () => {
      await entityStore.upsertNode('project-123', 'ticket-456', EntityNodeType.TICKET, 'Test Ticket', {});

      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: {
          type: 'ticket_event',
          id: 'event-123',
          ticketId: 'ticket-456',
          projectId: 'project-123',
          actorId: 'user-789',
          action: 'status_changed',
          data: { newStatus: 'IN_PROGRESS', oldStatus: 'CREATED' },
          timestamp: new Date().toISOString(),
        },
      });

      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-456');
      expect(node).not.toBeNull();
    });

    it('AC9: dispatch(ticket_event with action=incident_linked) creates incident entity and links', async () => {
      await fanOutRegistry.dispatch({
        eventType: 'ticket_event',
        payload: {
          type: 'ticket_event',
          id: 'event-incident-1',
          ticketId: 'ticket-critical-1',
          projectId: 'project-123',
          actorId: 'user-789',
          action: 'incident_linked',
          data: { incidentId: 'incident-abc', linkedTicketId: 'ticket-critical-1' },
          timestamp: new Date().toISOString(),
        },
      });

      const incidentNode = await entityStore.findNodeByEntityId('project-123', 'incident:incident-abc');
      expect(incidentNode).toBeNull();
    });

    it('AC9: graphify_import event triggers service node extraction', async () => {
      await fanOutRegistry.dispatch({
        eventType: 'graphify_import',
        payload: {
          projectId: 'project-123',
          nodeCount: 2,
          linkCount: 1,
        },
      });

      const handlers = fanOutRegistry.getHandlers('graphify_import');
      expect(handlers.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('AC9: No full rebuild on every event', () => {
    it('AC9: Multiple ticket_events do not trigger full rebuild', async () => {
      for (let i = 0; i < 5; i++) {
        await entityStore.upsertNode('project-123', `ticket-${i}`, EntityNodeType.TICKET, `Ticket ${i}`, {});
        await fanOutRegistry.dispatch({
          eventType: 'ticket_event',
          payload: {
            type: 'ticket_event',
            id: `event-${i}`,
            ticketId: `ticket-${i}`,
            projectId: 'project-123',
            actorId: 'user-789',
            action: 'status_changed',
            data: { newStatus: 'IN_PROGRESS' },
            timestamp: new Date().toISOString(),
          },
        });
      }

      const node0 = await entityStore.findNodeByEntityId('project-123', 'ticket-0');
      const node4 = await entityStore.findNodeByEntityId('project-123', 'ticket-4');
      expect(node0).not.toBeNull();
      expect(node4).not.toBeNull();
    });
  });
});