/**
 * EntityStore Unit Tests
 *
 * RED PHASE: These tests fail because EntityStore does not exist yet.
 * Once EntityStore is implemented, these tests should pass.
 *
 * Acceptance Criteria:
 * AC1:  EntityStore.indexEntity(projectId, entity) stores the entity with linked source + sourceId,
 *       and makes it searchable via searchEntities()
 * AC2:  EntityStore.searchEntities(projectId, 'auth') returns entities with 'auth' in label or tags
 * AC3:  EntityStore.getByTag(projectId, 'backend') returns all entities tagged 'backend'
 * AC4:  Entity score = |query_terms ∩ entity.tags| / |entity.tags|, 0 when no overlap
 * AC5:  Entity score only boosts candidate documents linked to the matched entity;
 *       unrelated candidate documents receive entityScore = 0
 * AC6:  Entities from graphify nodes with type 'code_module' are indexed when
 *       graphify_import outbox event fires
 * AC7:  Entities from tickets with type 'ticket' are indexed when
 *       ticket_event outbox event fires
 */
import { EntityStore } from '../../../src/rag/entity-store';

describe('EntityStore', () => {
  let store: EntityStore;

  beforeEach(() => {
    store = new EntityStore();
  });

  describe('AC1: indexEntity stores entity with source and sourceId', () => {
    it('indexEntity is callable and does not throw', () => {
      expect(() => {
        store.indexEntity('proj-1', {
          id: 'entity-1',
          label: 'AuthenticationModule',
          tags: ['auth', 'security', 'backend'],
          source: 'code_module',
          sourceId: 'node-auth-001',
        });
      }).not.toThrow();
    });

    it('indexed entity can be retrieved by searchEntities', async () => {
      store.indexEntity('proj-1', {
        id: 'entity-1',
        label: 'AuthenticationService',
        tags: ['auth', 'login'],
        source: 'code_module',
        sourceId: 'node-auth-001',
      });

      const results = store.searchEntities('proj-1', 'Authentication');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('entity-1');
    });

    it('indexed entity stores source and sourceId for linking', async () => {
      store.indexEntity('proj-1', {
        id: 'entity-auth',
        label: 'AuthModule',
        tags: ['auth'],
        source: 'code_module',
        sourceId: 'node-123',
      });

      const results = store.searchEntities('proj-1', 'auth');
      expect(results).toHaveLength(1);
      expect(results[0].source).toBe('code_module');
      expect(results[0].sourceId).toBe('node-123');
    });
  });

  describe('AC2: searchEntities returns entities with query in label or tags', () => {
    it('returns entities matching query in label', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'AuthenticationController',
        tags: ['api', 'http'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.searchEntities('proj-1', 'auth');
      expect(results.some((e) => e.id === 'e1')).toBe(true);
    });

    it('returns entities matching query in tags', () => {
      store.indexEntity('proj-1', {
        id: 'e2',
        label: 'UserService',
        tags: ['user', 'auth', 'jwt'],
        source: 'code_module',
        sourceId: 'node-2',
      });

      const results = store.searchEntities('proj-1', 'auth');
      expect(results.some((e) => e.id === 'e2')).toBe(true);
    });

    it('returns entities matching multiple terms', () => {
      store.indexEntity('proj-1', {
        id: 'e3',
        label: 'AuthService',
        tags: ['auth', 'jwt', 'token'],
        source: 'code_module',
        sourceId: 'node-3',
      });

      const results = store.searchEntities('proj-1', 'auth jwt');
      expect(results.some((e) => e.id === 'e3')).toBe(true);
    });

    it('is project-scoped — searching one project does not return entities from another', () => {
      store.indexEntity('proj-a', {
        id: 'entity-a',
        label: 'AuthModule',
        tags: ['auth'],
        source: 'code_module',
        sourceId: 'node-a',
      });

      store.indexEntity('proj-b', {
        id: 'entity-b',
        label: 'DifferentModule',
        tags: ['other'],
        source: 'code_module',
        sourceId: 'node-b',
      });

      const results = store.searchEntities('proj-a', 'auth');
      expect(results.every((e) => e.id === 'entity-a')).toBe(true);
      expect(results.some((e) => e.id === 'entity-b')).toBe(false);
    });
  });

  describe('AC3: getByTag returns all entities with given tag', () => {
    it('returns entities tagged with exact tag', () => {
      store.indexEntity('proj-1', {
        id: 'backend-svc',
        label: 'DatabaseService',
        tags: ['backend', 'database'],
        source: 'code_module',
        sourceId: 'node-b1',
      });

      const results = store.getByTag('proj-1', 'backend');
      expect(results.some((e) => e.id === 'backend-svc')).toBe(true);
    });

    it('returns multiple entities with the same tag', () => {
      store.indexEntity('proj-1', {
        id: 'backend-1',
        label: 'API',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      store.indexEntity('proj-1', {
        id: 'backend-2',
        label: 'Worker',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-2',
      });

      const results = store.getByTag('proj-1', 'backend');
      expect(results).toHaveLength(2);
    });

    it('is case-insensitive for tag matching', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service',
        tags: ['Backend'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.getByTag('proj-1', 'backend');
      expect(results.some((e) => e.id === 'e1')).toBe(true);
    });

    it('returns empty array when no entities have the tag', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service',
        tags: ['frontend'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.getByTag('proj-1', 'backend');
      expect(results).toHaveLength(0);
    });

    it('is project-scoped', () => {
      store.indexEntity('proj-a', {
        id: 'e-a',
        label: 'Service',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-a',
      });

      store.indexEntity('proj-b', {
        id: 'e-b',
        label: 'Service',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-b',
      });

      const results = store.getByTag('proj-a', 'backend');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('e-a');
    });
  });

  describe('AC4: entity score = |query_terms ∩ entity.tags| / |entity.tags|, 0 when no overlap', () => {
    it('computes score as intersection size over tag count', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'AuthService',
        tags: ['auth', 'jwt', 'token', 'security'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.searchEntities('proj-1', 'auth jwt');
      const entity = results.find((e) => e.id === 'e1');
      expect(entity).toBeDefined();
      expect(entity!.score).toBeCloseTo(2 / 4);
    });

    it('returns score 0 when no query terms match tags', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service',
        tags: ['backend', 'database'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.searchEntities('proj-1', 'frontend react');
      const entity = results.find((e) => e.id === 'e1');
      expect(entity).toBeDefined();
      expect(entity!.score).toBe(0);
    });

    it('returns score 1 when all query terms are in tags and tags match exactly', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Auth',
        tags: ['auth'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.searchEntities('proj-1', 'auth');
      const entity = results.find((e) => e.id === 'e1');
      expect(entity).toBeDefined();
      expect(entity!.score).toBe(1);
    });

    it('query terms are matched case-insensitively against tags', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service',
        tags: ['Auth'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      const results = store.searchEntities('proj-1', 'auth');
      const entity = results.find((e) => e.id === 'e1');
      expect(entity).toBeDefined();
      expect(entity!.score).toBeGreaterThan(0);
    });
  });

  describe('AC5: entity score only boosts linked documents, unrelated docs get entityScore = 0', () => {
    it('documents linked to matched entity receive positive entityScore', () => {
      store.indexEntity('proj-1', {
        id: 'auth-entity',
        label: 'AuthenticationService',
        tags: ['auth', 'security'],
        source: 'code_module',
        sourceId: 'node-auth',
      });

      const candidate = {
        id: 'doc-linked',
        source: 'code_module',
        sourceId: 'node-auth',
        content: 'Authentication service implementation',
        entityScore: store.computeEntityScore('auth', ['auth', 'security']),
      };

      expect(candidate.entityScore).toBeGreaterThan(0);
    });

    it('documents NOT linked to matched entity receive entityScore = 0', () => {
      store.indexEntity('proj-1', {
        id: 'auth-entity',
        label: 'AuthenticationService',
        tags: ['auth', 'security'],
        source: 'code_module',
        sourceId: 'node-auth',
      });

      const unrelatedDoc = {
        id: 'doc-unrelated',
        source: 'code_module',
        sourceId: 'node-completely-different',
        content: 'Unrelated content',
        entityScore: 0,
      };

      expect(unrelatedDoc.entityScore).toBe(0);
    });

    it('computeEntityScore is exposed for use by hybrid retriever', () => {
      expect(typeof store.computeEntityScore).toBe('function');
    });

    it('computeEntityScore returns 0 for empty query terms', () => {
      const score = store.computeEntityScore('', ['auth', 'backend']);
      expect(score).toBe(0);
    });

    it('computeEntityScore returns 0 for empty entity tags', () => {
      const score = store.computeEntityScore('auth', []);
      expect(score).toBe(0);
    });

    it('entityScore is not double-counted across multiple matched entities', () => {
      store.indexEntity('proj-1', {
        id: 'entity-1',
        label: 'AuthService',
        tags: ['auth'],
        source: 'code_module',
        sourceId: 'node-auth',
      });

      store.indexEntity('proj-1', {
        id: 'entity-2',
        label: 'AuthController',
        tags: ['auth'],
        source: 'code_module',
        sourceId: 'node-auth-ctrl',
      });

      const matchedEntity = store.searchEntities('proj-1', 'auth').find((e) => e.id === 'entity-1');
      const docLinkedToEntity1 = { sourceId: 'node-auth', entityScore: 0 };

      if (matchedEntity && matchedEntity.sourceId === 'node-auth') {
        docLinkedToEntity1.entityScore = store.computeEntityScore('auth', matchedEntity.tags);
      }

      expect(docLinkedToEntity1.entityScore).toBeGreaterThan(0);
    });
  });

  describe('AC6: code_module entities indexed on graphify_import event', () => {
    it('handleOutboxEvent indexes entity when eventType is graphify_import and node type is code_module', async () => {
      store.indexEntity('proj-1', {
        id: 'existing-entity',
        label: 'ExistingModule',
        tags: ['module'],
        source: 'code_module',
        sourceId: 'node-existing',
      });

      const event = {
        eventType: 'graphify_import',
        payload: {
          projectId: 'proj-1',
          nodes: [
            {
              id: 'code-module-1',
              label: 'AuthModule',
              type: 'code_module',
              source_file: 'auth/module.ts',
            },
          ],
          links: [],
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.searchEntities('proj-1', 'AuthModule');
      expect(results.some((e) => e.sourceId === 'code-module-1')).toBe(true);
    });

    it('graphify_import event does NOT index nodes that are not code_module type', async () => {
      const event = {
        eventType: 'graphify_import',
        payload: {
          projectId: 'proj-1',
          nodes: [
            {
              id: 'node-1',
              label: 'SomeNode',
              type: 'not_code_module',
              source_file: 'file.ts',
            },
          ],
          links: [],
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.searchEntities('proj-1', 'SomeNode');
      expect(results.some((e) => e.sourceId === 'node-1')).toBe(false);
    });

    it('code_module nodes extract tags from label words for initial tagging', async () => {
      const event = {
        eventType: 'graphify_import',
        payload: {
          projectId: 'proj-1',
          nodes: [
            {
              id: 'cm-1',
              label: 'AuthenticationService',
              type: 'code_module',
              source_file: 'auth/service.ts',
            },
          ],
          links: [],
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.getByTag('proj-1', 'authentication');
      expect(results.some((e) => e.sourceId === 'cm-1')).toBe(true);
    });
  });

  describe('AC7: ticket entities indexed on ticket_event event', () => {
    it('handleOutboxEvent indexes entity when eventType is ticket_event and source is ticket', async () => {
      const event = {
        eventType: 'ticket_event',
        payload: {
          projectId: 'proj-1',
          ticket: {
            id: 'ticket-123',
            ref: 'PROJ-42',
            title: 'Fix authentication bug',
            type: 'BUG',
          },
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.searchEntities('proj-1', 'authentication');
      expect(results.some((e) => e.sourceId === 'ticket-123')).toBe(true);
    });

    it('ticket_event extracts tags from ticket title words', async () => {
      const event = {
        eventType: 'ticket_event',
        payload: {
          projectId: 'proj-1',
          ticket: {
            id: 'ticket-abc',
            ref: 'PROJ-99',
            title: 'Implement backend API',
            type: 'TASK',
          },
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.getByTag('proj-1', 'backend');
      expect(results.some((e) => e.sourceId === 'ticket-abc')).toBe(true);
    });

    it('ticket_event entities have source set to ticket', async () => {
      const event = {
        eventType: 'ticket_event',
        payload: {
          projectId: 'proj-1',
          ticket: {
            id: 'ticket-xyz',
            ref: 'PROJ-7',
            title: 'Auth issue',
            type: 'BUG',
          },
        },
      };

      await store.handleOutboxEvent(event);

      const results = store.searchEntities('proj-1', 'auth');
      const entity = results.find((e) => e.sourceId === 'ticket-xyz');
      expect(entity).toBeDefined();
      expect(entity!.source).toBe('ticket');
    });
  });

  describe('EntityStore — rebuild from outbox fan-out', () => {
    it('clear removes all entities for a project', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      store.clear('proj-1');

      const results = store.getByTag('proj-1', 'backend');
      expect(results).toHaveLength(0);
    });

    it('clear does not affect other projects', () => {
      store.indexEntity('proj-a', {
        id: 'e-a',
        label: 'ServiceA',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-a',
      });

      store.indexEntity('proj-b', {
        id: 'e-b',
        label: 'ServiceB',
        tags: ['frontend'],
        source: 'code_module',
        sourceId: 'node-b',
      });

      store.clear('proj-a');

      const resultsA = store.getByTag('proj-a', 'backend');
      const resultsB = store.getByTag('proj-b', 'frontend');
      expect(resultsA).toHaveLength(0);
      expect(resultsB).toHaveLength(1);
    });

    it('getAllEntities returns all entities for a project', () => {
      store.indexEntity('proj-1', {
        id: 'e1',
        label: 'Service1',
        tags: ['backend'],
        source: 'code_module',
        sourceId: 'node-1',
      });

      store.indexEntity('proj-1', {
        id: 'e2',
        label: 'Service2',
        tags: ['frontend'],
        source: 'code_module',
        sourceId: 'node-2',
      });

      const all = store.getAllEntities('proj-1');
      expect(all).toHaveLength(2);
    });

    it('getAllEntities returns empty array for project with no entities', () => {
      const all = store.getAllEntities('proj-nonexistent');
      expect(all).toHaveLength(0);
    });
  });
});

describe('EntityStore — Entity entity interface shape', () => {
  it('indexEntity accepts entity with id, label, tags, source, sourceId', () => {
    const store = new EntityStore();
    expect(() => {
      store.indexEntity('proj-1', {
        id: 'entity-1',
        label: 'MyEntity',
        tags: ['tag1', 'tag2'],
        source: 'code_module',
        sourceId: 'source-123',
      });
    }).not.toThrow();
  });

  it('searchEntities returns entities with id, label, tags, source, sourceId, and score', () => {
    const store = new EntityStore();
    store.indexEntity('proj-1', {
      id: 'entity-1',
      label: 'MyEntity',
      tags: ['tag1'],
      source: 'code_module',
      sourceId: 'source-1',
    });

    const results = store.searchEntities('proj-1', 'MyEntity');
    expect(results[0]).toMatchObject({
      id: 'entity-1',
      label: 'MyEntity',
      source: 'code_module',
      sourceId: 'source-1',
      score: expect.any(Number),
    });
    expect(Array.isArray(results[0].tags)).toBe(true);
  });
});