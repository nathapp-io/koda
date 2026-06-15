import { EntityGraphService } from './entity-graph.service';
import { InMemoryEntityStore } from './in-memory-entity-store';
import { EntityNodeType, EntityLinkRelation } from './dto/entity-graph.types';

describe('EntityGraphService comprehensive coverage', () => {
  let service: EntityGraphService;
  let entityStore: InMemoryEntityStore;
  let mockEntityGraphRepo: any;

  beforeEach(() => {
    entityStore = new InMemoryEntityStore();
    mockEntityGraphRepo = {
      findTicketsWithLabelsAndLinks: jest.fn().mockResolvedValue([]),
      findGraphNodesByType: jest.fn().mockResolvedValue([]),
      findGraphLinksByRelation: jest.fn().mockResolvedValue([]),
    };
    service = new EntityGraphService(entityStore, mockEntityGraphRepo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('rebuildGraph with Prisma', () => {
    it('creates ticket-to-service links via gitRefFile matching', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'Auth bug',
          status: 'OPEN',
          priority: 'MEDIUM',
          type: 'BUG',
          number: 1,
          gitRefFile: 'apps/api/src/auth.ts',
          gitRefVersion: null,
          gitRefLine: null,
          labels: [],
          links: [],
          assignedToUserId: null,
          assignedToAgentId: null,
        },
      ]);
      mockEntityGraphRepo.findGraphNodesByType.mockResolvedValue([
        {
          nodeId: 'auth-module',
          label: 'AuthService',
          type: 'code_module',
          sourceFile: 'apps/api/src/auth.ts',
          community: null,
        },
      ]);

      await service.rebuildGraph('project-123');

      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      const ticketToServiceLink = links.find(
        (l) => l.relation === EntityLinkRelation.TICKET_TO_SERVICE,
      );
      expect(ticketToServiceLink).toBeDefined();
      expect(ticketToServiceLink?.targetId).toBe('service:auth-module');
    });

    it('creates ticket-to-service links via label/tag matching', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'Auth bug',
          status: 'OPEN',
          priority: 'MEDIUM',
          type: 'BUG',
          number: 1,
          gitRefFile: null,
          gitRefVersion: null,
          gitRefLine: null,
          labels: [{ label: { name: 'backend' } }],
          links: [],
          assignedToUserId: null,
          assignedToAgentId: null,
        },
      ]);
      mockEntityGraphRepo.findGraphNodesByType.mockResolvedValue([
        {
          nodeId: 'auth-module',
          label: 'AuthService',
          type: 'code_module',
          sourceFile: null,
          community: null,
        },
      ]);
      // Pre-seed the service node with tags so findNodesByType returns it
      await entityStore.upsertNode(
        'project-123',
        'service:auth-module',
        EntityNodeType.SERVICE,
        'AuthService',
        { tags: ['backend'] },
      );

      await service.rebuildGraph('project-123');

      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      const ticketToServiceLink = links.find(
        (l) => l.relation === EntityLinkRelation.TICKET_TO_SERVICE,
      );
      expect(ticketToServiceLink).toBeDefined();
      expect(ticketToServiceLink?.targetId).toBe('service:auth-module');
    });

    it('creates incident nodes for critical tickets', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'Critical outage',
          status: 'OPEN',
          priority: 'CRITICAL',
          type: 'BUG',
          number: 1,
          gitRefFile: null,
          gitRefVersion: null,
          gitRefLine: null,
          labels: [],
          links: [],
          assignedToUserId: null,
          assignedToAgentId: null,
        },
      ]);

      await service.rebuildGraph('project-123');

      const incidentNode = await entityStore.findNodeByEntityId(
        'project-123',
        'incident:ticket-1',
      );
      expect(incidentNode).not.toBeNull();
      expect(incidentNode?.entityType).toBe(EntityNodeType.INCIDENT);
    });

    it('creates incident nodes for high priority tickets', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'High severity bug',
          status: 'OPEN',
          priority: 'HIGH',
          type: 'BUG',
          number: 1,
          gitRefFile: null,
          gitRefVersion: null,
          gitRefLine: null,
          labels: [],
          links: [],
          assignedToUserId: null,
          assignedToAgentId: null,
        },
      ]);

      await service.rebuildGraph('project-123');

      const incidentNode = await entityStore.findNodeByEntityId(
        'project-123',
        'incident:ticket-1',
      );
      expect(incidentNode).not.toBeNull();
      expect(incidentNode?.entityType).toBe(EntityNodeType.INCIDENT);
    });

    it('does not create incident nodes for medium priority tickets', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'Medium bug',
          status: 'OPEN',
          priority: 'MEDIUM',
          type: 'BUG',
          number: 1,
          gitRefFile: null,
          gitRefVersion: null,
          gitRefLine: null,
          labels: [],
          links: [],
          assignedToUserId: null,
          assignedToAgentId: null,
        },
      ]);

      await service.rebuildGraph('project-123');

      const incidentNode = await entityStore.findNodeByEntityId(
        'project-123',
        'incident:ticket-1',
      );
      expect(incidentNode).toBeNull();
    });

    it('creates service-to-service links from graphLink depends_on records', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([]);
      mockEntityGraphRepo.findGraphNodesByType.mockResolvedValue([
        {
          nodeId: 'auth-module',
          label: 'AuthService',
          type: 'code_module',
          sourceFile: null,
          community: null,
        },
        {
          nodeId: 'db-module',
          label: 'DatabaseService',
          type: 'code_module',
          sourceFile: null,
          community: null,
        },
      ]);
      mockEntityGraphRepo.findGraphLinksByRelation.mockResolvedValue([
        {
          sourceId: 'auth-module',
          targetId: 'db-module',
          relation: 'depends_on',
        },
      ]);

      await service.rebuildGraph('project-123');

      const links = await entityStore.findLinksBySource('project-123', 'service:auth-module');
      const dependsOnLink = links.find(
        (l) => l.relation === EntityLinkRelation.SERVICE_TO_SERVICE,
      );
      expect(dependsOnLink).toBeDefined();
      expect(dependsOnLink?.targetId).toBe('service:db-module');
    });

    it('creates owner nodes and links for assigned tickets', async () => {
      mockEntityGraphRepo.findTicketsWithLabelsAndLinks.mockResolvedValue([
        {
          id: 'ticket-1',
          title: 'Bug',
          status: 'OPEN',
          priority: 'MEDIUM',
          type: 'BUG',
          number: 1,
          gitRefFile: null,
          gitRefVersion: null,
          gitRefLine: null,
          labels: [],
          links: [],
          assignedToUserId: 'user-abc',
          assignedToAgentId: null,
        },
      ]);

      await service.rebuildGraph('project-123');

      const ownerNode = await entityStore.findNodeByEntityId('project-123', 'owner:user-abc');
      expect(ownerNode).not.toBeNull();
      expect(ownerNode?.entityType).toBe(EntityNodeType.OWNER);

      const links = await entityStore.findLinksBySource('project-123', 'ticket-1');
      const ownerLink = links.find((l) => l.relation === EntityLinkRelation.TICKET_TO_OWNER);
      expect(ownerLink).toBeDefined();
    });
  });

  describe('onGraphifyImport with explicit links', () => {
    it('creates service-to-service links from explicit depends_on links', async () => {
      await service.onGraphifyImport(
        'project-123',
        [
          { nodeId: 'auth-module', type: 'code_module', label: 'AuthService' },
          { nodeId: 'db-module', type: 'code_module', label: 'DatabaseService' },
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

    it('ignores non-depends_on explicit links', async () => {
      await service.onGraphifyImport(
        'project-123',
        [
          { nodeId: 'auth-module', type: 'code_module', label: 'AuthService' },
          { nodeId: 'db-module', type: 'code_module', label: 'DatabaseService' },
        ],
        [{ sourceId: 'auth-module', targetId: 'db-module', relation: 'calls' }],
      );

      const links = await entityStore.findLinksBySource('project-123', 'service:auth-module');
      const serviceLink = links.find(
        (l) => l.relation === EntityLinkRelation.SERVICE_TO_SERVICE,
      );
      expect(serviceLink).toBeUndefined();
    });
  });

  describe('getRelatedEntities content verification', () => {
    it('returns correct paths with actual node content', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {});
      await entityStore.upsertNode('project-123', 'service-1', EntityNodeType.SERVICE, 'Service 1', {});
      await entityStore.upsertNode('project-123', 'owner-1', EntityNodeType.OWNER, 'Owner 1', {});
      await entityStore.upsertLink(
        'project-123',
        'ticket-1',
        'service-1',
        EntityLinkRelation.TICKET_TO_SERVICE,
        {},
      );
      await entityStore.upsertLink(
        'project-123',
        'service-1',
        'owner-1',
        EntityLinkRelation.SERVICE_TO_SERVICE,
        {},
      );

      const result = await service.getRelatedEntities('project-123', 'ticket-1', 2);

      // Should have path to service-1 (depth 1) and owner-1 (depth 2)
      const pathToService = result.find((p) => p.path.some((n) => n.entityId === 'service-1'));
      const pathToOwner = result.find((p) => p.path.some((n) => n.entityId === 'owner-1'));

      expect(pathToService).toBeDefined();
      expect(pathToService?.depth).toBe(1);
      expect(pathToService?.path.length).toBe(2);
      expect(pathToService?.path[0].entityId).toBe('ticket-1');
      expect(pathToService?.path[1].entityId).toBe('service-1');

      expect(pathToOwner).toBeDefined();
      expect(pathToOwner?.depth).toBe(2);
      expect(pathToOwner?.path.length).toBe(3);
      expect(pathToOwner?.path[2].entityId).toBe('owner-1');
    });

    it('returns empty array for non-existent entity', async () => {
      const result = await service.getRelatedEntities('project-123', 'non-existent', 2);
      expect(result).toEqual([]);
    });
  });

  describe('getIncidentImpact content verification', () => {
    it('returns correct affected entities after multi-hop traversal', async () => {
      await entityStore.upsertNode(
        'project-123',
        'incident-1',
        EntityNodeType.INCIDENT,
        'Critical Bug',
        {},
      );
      await entityStore.upsertNode(
        'project-123',
        'ticket-1',
        EntityNodeType.TICKET,
        'Related Ticket',
        {},
      );
      await entityStore.upsertNode(
        'project-123',
        'service-1',
        EntityNodeType.SERVICE,
        'Affected Service',
        {},
      );
      await entityStore.upsertNode(
        'project-123',
        'code-1',
        EntityNodeType.CODE_MODULE,
        'Code Module',
        {},
      );

      await entityStore.upsertLink(
        'project-123',
        'incident-1',
        'ticket-1',
        EntityLinkRelation.INCIDENT_TO_TICKET,
        {},
      );
      await entityStore.upsertLink(
        'project-123',
        'ticket-1',
        'service-1',
        EntityLinkRelation.TICKET_TO_SERVICE,
        {},
      );
      await entityStore.upsertLink(
        'project-123',
        'service-1',
        'code-1',
        EntityLinkRelation.SERVICE_TO_SERVICE,
        {},
      );

      const result = await service.getIncidentImpact('project-123', 'incident-1');

      expect(result.incidentTicketId).toBe('incident-1');
      expect(result.affectedTickets).toHaveLength(1);
      expect(result.affectedTickets[0].entityId).toBe('ticket-1');
      expect(result.affectedServices).toHaveLength(1);
      expect(result.affectedServices[0].entityId).toBe('service-1');
      expect(result.affectedCodeModules).toHaveLength(1);
      expect(result.affectedCodeModules[0].entityId).toBe('code-1');
    });

    it('resolves incident prefix when looking up by ticket id', async () => {
      await entityStore.upsertNode(
        'project-123',
        'incident:ticket-1',
        EntityNodeType.INCIDENT,
        'Critical Bug',
        {},
      );
      await entityStore.upsertNode(
        'project-123',
        'ticket-1',
        EntityNodeType.TICKET,
        'Ticket 1',
        {},
      );
      await entityStore.upsertLink(
        'project-123',
        'incident:ticket-1',
        'ticket-1',
        EntityLinkRelation.INCIDENT_TO_TICKET,
        {},
      );

      const result = await service.getIncidentImpact('project-123', 'ticket-1');

      expect(result.affectedTickets).toHaveLength(1);
      expect(result.affectedTickets[0].entityId).toBe('ticket-1');
    });

    it('returns empty arrays when incident node does not exist', async () => {
      const result = await service.getIncidentImpact('project-123', 'non-existent');
      expect(result.affectedServices).toEqual([]);
      expect(result.affectedTickets).toEqual([]);
      expect(result.affectedCodeModules).toEqual([]);
    });
  });

  describe('onTicketEvent status_changed', () => {
    it('updates ticket node metadata when node exists', async () => {
      await entityStore.upsertNode('project-123', 'ticket-1', EntityNodeType.TICKET, 'Ticket 1', {
        status: 'CREATED',
        priority: 'HIGH',
      });

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
      expect(node?.metadata?.status).toBe('IN_PROGRESS');
      expect(node?.metadata?.priority).toBe('HIGH');
      expect(node?.metadata?.lastEventId).toBe('event-1');
    });

    it('does not create ticket node when it does not exist', async () => {
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
  });
});
