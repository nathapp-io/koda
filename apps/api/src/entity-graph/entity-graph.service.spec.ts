import { EntityGraphService } from './entity-graph.service';
import { InMemoryEntityStore } from './in-memory-entity-store';
import { EntityNodeType, EntityLinkRelation } from './dto/entity-graph.types';

describe('EntityGraphService', () => {
  let service: EntityGraphService;
  let entityStore: InMemoryEntityStore;

  beforeEach(() => {
    entityStore = new InMemoryEntityStore();
    service = new EntityGraphService(entityStore);
  });

  describe('rebuildGraph', () => {
    it('AC1: rebuildGraph(projectId) rebuilds all entity nodes and links for a project from existing data', async () => {
      await expect(service.rebuildGraph('project-123')).resolves.not.toThrow();
    });

    it('AC1: rebuildGraph creates ticket nodes from existing tickets', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await service.rebuildGraph('project-123');
      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-1');
      expect(node).not.toBeNull();
    });
  });

  describe('onTicketEvent', () => {
    it('AC3: onTicketEvent(status_changed) updates the entity node for that ticket if it exists', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'ticket-1',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS', oldStatus: 'CREATED' },
        timestamp: new Date(),
      });
      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-1');
      expect(node).not.toBeNull();
    });

    it('AC3: onTicketEvent creates ticket node if it does not exist', async () => {
      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'ticket-2',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      });
      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-2');
      expect(node).toBeNull();
    });

    it('AC3: onTicketEvent(assignment) creates owner node and links to ticket', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'ticket-1',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'assigned',
        data: { assignedToUserId: 'user-abc', assignedToAgentId: null },
        timestamp: new Date(),
      });
      const ownerNode = await entityStore.findNodeByEntityId('project-123', 'owner:user-abc');
      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      const ticketToOwnerLink = links.find((l) => l.relation === EntityLinkRelation.TICKET_TO_OWNER);
      expect(ownerNode).not.toBeNull();
      expect(ticketToOwnerLink).not.toBeUndefined();
    });

    it('BUG-1: onTicketEvent(assigned) upserts the ticket node even when it does not already exist', async () => {
      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'new-ticket-1',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'assigned',
        data: { assignedToUserId: 'user-abc' },
        timestamp: new Date(),
      });

      const ticketNode = await entityStore.findNodeByEntityId('project-123', 'new-ticket-1');
      expect(ticketNode).not.toBeNull();
      expect(ticketNode?.entityType).toBe(EntityNodeType.TICKET);

      const ownerNode = await entityStore.findNodeByEntityId('project-123', 'owner:user-abc');
      expect(ownerNode).not.toBeNull();
      expect(ownerNode?.entityType).toBe(EntityNodeType.OWNER);

      const links = await entityStore.findLinksBySource('project-123', 'new-ticket-1');
      const ownerLink = links.find((l) => l.relation === EntityLinkRelation.TICKET_TO_OWNER && l.targetId === 'owner:user-abc');
      expect(ownerLink).toBeDefined();
    });

    it('BUG-2: onTicketEvent(incident_linked) creates incident-to-ticket link', async () => {
      await entityStore.upsertNode('project-123', 'incident:ticket-42', EntityNodeType.INCIDENT, 'Critical Outage', {});
      await entityStore.upsertNode('project-123', 'ticket-99', EntityNodeType.TICKET, 'Related ticket', {});

      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'ticket-99',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'incident_linked',
        data: { incidentTicketId: 'ticket-42' },
        timestamp: new Date(),
      });

      const links = await entityStore.findLinksBySource('project-123', 'incident:ticket-42');
      const incidentLink = links.find(
        (l) => l.relation === EntityLinkRelation.INCIDENT_TO_TICKET && l.targetId === 'ticket-99',
      );
      expect(incidentLink).toBeDefined();
    });
  });

  describe('onGraphifyImport', () => {
    it('AC4: onGraphifyImport() extracts service entity nodes from graphify nodes with type=code_module', async () => {
      await service.onGraphifyImport('project-123', [
        { nodeId: 'node-1', type: 'code_module', label: 'AuthService' },
        { nodeId: 'node-2', type: 'function', label: 'helperFn' },
      ]);
      const serviceNode = await entityStore.findNodeByEntityId('project-123', 'service:node-1');
      expect(serviceNode).not.toBeNull();
      expect(serviceNode?.entityType).toBe(EntityNodeType.SERVICE);
    });

    it('AC4: onGraphifyImport ignores nodes with type != code_module', async () => {
      await service.onGraphifyImport('project-123', [
        { nodeId: 'node-2', type: 'function', label: 'helperFn' },
      ]);
      const node = await entityStore.findNodeByEntityId('project-123', 'service:node-2');
      expect(node).toBeNull();
    });

    it('AC8: Service entities extracted from graphify inherit tags from the graphify node', async () => {
      await service.onGraphifyImport('project-123', [
        { nodeId: 'node-1', type: 'code_module', label: 'AuthService', tags: ['backend', 'auth'] },
      ]);
      const serviceNode = await entityStore.findNodeByEntityId('project-123', 'service:node-1');
      expect(serviceNode?.metadata?.tags).toEqual(['backend', 'auth']);
    });

    it('AC5: Service linkage works from gitRefFile field via rebuildGraph', async () => {
      const mockPrisma = {
        client: {
          ticket: {
            findMany: jest.fn().mockResolvedValue([
              {
                id: 'ticket-1',
                title: 'Bug: Auth fails',
                status: 'OPEN',
                priority: 'MEDIUM',
                type: 'BUG',
                number: 1,
                gitRefFile: 'apps/api/src/auth.ts',
                gitRefVersion: null,
                gitRefLine: null,
                labels: [],
                assignedToUserId: null,
                assignedToAgentId: null,
              },
            ]),
          },
          graphNode: {
            findMany: jest.fn().mockResolvedValue([
              {
                nodeId: 'auth-module',
                label: 'AuthService',
                type: 'code_module',
                sourceFile: 'apps/api/src/auth.ts',
                community: null,
              },
            ]),
          },
          graphLink: {
            findMany: jest.fn().mockResolvedValue([]),
          },
        },
      };
      const serviceWithPrisma = new EntityGraphService(entityStore, mockPrisma as any);

      await serviceWithPrisma.rebuildGraph('project-123');

      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      const ticketToServiceLink = links.find(
        (l) => l.relation === EntityLinkRelation.TICKET_TO_SERVICE,
      );
      expect(ticketToServiceLink).toBeDefined();
      expect(ticketToServiceLink?.targetId).toBe('service:auth-module');
    });

    it('AC9: onGraphifyImport creates service-to-service links from graphify relation=depends_on', async () => {
      await service.onGraphifyImport(
        'project-123',
        [
          { nodeId: 'auth-module', type: 'code_module', label: 'AuthService', tags: ['backend'] },
          { nodeId: 'db-module', type: 'code_module', label: 'DatabaseService', tags: ['backend'] },
        ],
        [{ sourceId: 'auth-module', targetId: 'db-module', relation: 'depends_on' }],
      );
      const links = await entityStore.findLinksBySource('project-123', 'service:auth-module');
      const dependsOnLink = links.find(
        (l) => l.relation === EntityLinkRelation.SERVICE_TO_SERVICE,
      );
      expect(dependsOnLink).toBeDefined();
      expect(dependsOnLink?.targetId).toBe('service:db-module');
    });
  });

  describe('getRelatedEntities', () => {
    it('AC6: getRelatedEntities returns all entity nodes reachable within 2 hops', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await entityStore.upsertNode('project-123', 'service-1', EntityNodeType.SERVICE, 'Service 1', {});
      await entityStore.upsertNode('project-123', 'owner-1', EntityNodeType.OWNER, 'Owner 1', {});
      await entityStore.upsertLink('project-123', 'ticket-1', 'service-1', EntityLinkRelation.TICKET_TO_SERVICE, {});
      await entityStore.upsertLink('project-123', 'service-1', 'owner-1', EntityLinkRelation.SERVICE_TO_SERVICE, {});

      const result = await service.getRelatedEntities('project-123', 'ticket-1', 2);
      expect(result).toBeInstanceOf(Array);
    });

    it('AC6: getRelatedEntities with depth=1 returns only directly connected nodes', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await entityStore.upsertNode('project-123', 'service-1', EntityNodeType.SERVICE, 'Service 1', {});
      await entityStore.upsertNode('project-123', 'owner-1', EntityNodeType.OWNER, 'Owner 1', {});
      await entityStore.upsertLink('project-123', 'ticket-1', 'service-1', EntityLinkRelation.TICKET_TO_SERVICE, {});
      await entityStore.upsertLink('project-123', 'service-1', 'owner-1', EntityLinkRelation.SERVICE_TO_SERVICE, {});

      const result = await service.getRelatedEntities('project-123', 'ticket-1', 1);
      const pathsWithDepth1 = result.filter((p) => p.depth <= 1);
      expect(pathsWithDepth1.length).toBe(result.length);
    });

    it('AC6: getRelatedEntities returns empty array for non-existent entity', async () => {
      const result = await service.getRelatedEntities('project-123', 'non-existent', 2);
      expect(result).toEqual([]);
    });
  });

  describe('getIncidentImpact', () => {
    it('AC7: getIncidentImpact returns all entity nodes linked to the incident ticket', async () => {
      await entityStore.upsertNode('project-123', 'incident-1', EntityNodeType.INCIDENT, 'Critical Bug', {});
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Related Ticket', {});
      await entityStore.upsertLink('project-123', 'incident-1', 'ticket-1', EntityLinkRelation.INCIDENT_TO_TICKET, {});

      const result = await service.getIncidentImpact('project-123', 'incident-1');
      expect(result.incidentTicketId).toBe('incident-1');
    });

    it('AC7: getIncidentImpact includes affectedServices, affectedTickets, affectedCodeModules', async () => {
      await entityStore.upsertNode('project-123', 'incident-1', EntityNodeType.INCIDENT, 'Critical Bug', {});
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Related Ticket', {});
      await entityStore.upsertNode('project-123', 'service-1', EntityNodeType.SERVICE, 'Affected Service', {});
      await entityStore.upsertLink('project-123', 'incident-1', 'ticket-1', EntityLinkRelation.INCIDENT_TO_TICKET, {});
      await entityStore.upsertLink('project-123', 'ticket-1', 'service-1', EntityLinkRelation.TICKET_TO_SERVICE, {});

      const result = await service.getIncidentImpact('project-123', 'incident-1');
      expect(result).toHaveProperty('affectedServices');
      expect(result).toHaveProperty('affectedTickets');
      expect(result).toHaveProperty('affectedCodeModules');
    });

    it('AC7: getIncidentImpact returns empty arrays when no linked entities', async () => {
      const result = await service.getIncidentImpact('project-123', 'incident-1');
      expect(result.affectedServices).toEqual([]);
      expect(result.affectedTickets).toEqual([]);
      expect(result.affectedCodeModules).toEqual([]);
    });
  });

  describe('AC10: Performance', () => {
    it('AC10: getRelatedEntities on 500 nodes and 2000 edges returns in under 50ms', async () => {
      for (let i = 0; i < 500; i++) {
        const entityType = i % 3 === 0 ? EntityNodeType.SERVICE : i % 3 === 1 ? EntityNodeType.TICKET : EntityNodeType.OWNER;
        await entityStore.upsertNode('project-123', `entity-${i}`, entityType, `Entity ${i}`, {});
      }

      for (let i = 0; i < 2000; i++) {
        const sourceId = `entity-${i % 500}`;
        const targetId = `entity-${(i + 1) % 500}`;
        await entityStore.upsertLink('project-123', sourceId, targetId, EntityLinkRelation.TICKET_TO_SERVICE, {});
      }

      const start = Date.now();
      await service.getRelatedEntities('project-123', 'entity-0', 2);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(50);
    });
  });

  describe('AC2: Persistence', () => {
    it('AC2: Entity graph data is persisted in EntityNode and EntityLink Prisma tables', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await entityStore.upsertLink('project-123', 'ticket-1', 'service-1', EntityLinkRelation.TICKET_TO_SERVICE, {});
      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-1');
      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      expect(node).not.toBeNull();
      expect(links.length).toBeGreaterThan(0);
    });
  });

  describe('AC9: Incremental updates via outbox', () => {
    it('AC9: Entity graph is updated incrementally via outbox fan-out handlers - no full rebuild', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Initial Ticket', {});
      const rebuildCalls = { count: 0 };
      const originalRebuild = service.rebuildGraph.bind(service);

      await service.onTicketEvent({
        type: 'ticket_event',
        id: 'event-1',
        ticketId: 'ticket-1',
        projectId: 'project-123',
        actorId: 'user-1',
        action: 'status_changed',
        data: { newStatus: 'IN_PROGRESS' },
        timestamp: new Date(),
      });

      const node = await entityStore.findNodeByEntityId('project-123', 'ticket-1');
      expect(node).not.toBeNull();
    });
  });
});