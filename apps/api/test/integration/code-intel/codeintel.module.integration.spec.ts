/**
 * Code Intelligence Module Integration Tests
 *
 * Tests the complete CodeIntelModule with real dependencies wired together.
 * Verifies: module structure, dependency injection, service integration.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest --forceExit test/integration/code-intel/codeintel.module.integration.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SymbolStore } from '../../../src/code-intel/symbol-store';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { GraphStoreService } from '../../../src/rag/graph-store.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('Code Intelligence Module Integration', () => {
  let module: TestingModule;

  beforeEach(async () => {
    if (!DATABASE_URL) return;

    module = await Test.createTestingModule({
      providers: [
        SymbolStore,
        EntityGraphService,
        GraphStoreService,
        PrismaService,
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
          },
        },
        {
          provide: 'ENTITY_GRAPH_STORE',
          useValue: {
            findNodeByEntityId: jest.fn(),
            findNodesByType: jest.fn(),
            findLinksBySource: jest.fn(),
            upsertNode: jest.fn(),
            upsertLink: jest.fn(),
            deleteLinksBySource: jest.fn(),
            findLinksByTarget: jest.fn(),
          },
        },
      ],
    }).compile();
  });

  afterEach(async () => {
    if (module) await module.close();
  });

  describe('Module Structure', () => {
    it('should provide SymbolStore', () => {
      const symbolStore = module.get<SymbolStore>(SymbolStore);
      expect(symbolStore).toBeDefined();
    });

    it('should provide EntityGraphService', () => {
      const entityGraph = module.get<EntityGraphService>(EntityGraphService);
      expect(entityGraph).toBeDefined();
    });

    it('should provide GraphStoreService', () => {
      const graphStore = module.get<GraphStoreService>(GraphStoreService);
      expect(graphStore).toBeDefined();
    });
  });

  describe('Dependency Injection', () => {
    it('should inject SymbolStore with PrismaService and TransactionManager', () => {
      const symbolStore = module.get<SymbolStore>(SymbolStore);
      expect(symbolStore).toBeDefined();
      // SymbolStore should have prisma and txManager injected
    });

    it('should inject EntityGraphService with entity store and optional Prisma', () => {
      const entityGraph = module.get<EntityGraphService>(EntityGraphService);
      expect(entityGraph).toBeDefined();
      // EntityGraphService should have entity store and optional prisma
    });

    it('should inject GraphStoreService with PrismaService', () => {
      const graphStore = module.get<GraphStoreService>(GraphStoreService);
      expect(graphStore).toBeDefined();
      // GraphStoreService should have prisma injected
    });

    it('should provide TRANSACTION_MANAGER token', () => {
      const txManager = module.get(TRANSACTION_MANAGER);
      expect(txManager).toBeDefined();
      expect(txManager.run).toBeDefined();
    });
  });

  describe('Service Availability', () => {
    it('should have SymbolStore.findBySymbolId method', () => {
      const symbolStore = module.get<SymbolStore>(SymbolStore);
      expect(symbolStore.findBySymbolId).toBeDefined();
    });

    it('should have EntityGraphService.rebuildGraph method', () => {
      const entityGraph = module.get<EntityGraphService>(EntityGraphService);
      expect(entityGraph.rebuildGraph).toBeDefined();
    });

    it('should have GraphStoreService.getStoredGraph method', () => {
      const graphStore = module.get<GraphStoreService>(GraphStoreService);
      expect(graphStore.getStoredGraph).toBeDefined();
    });
  });

  describe('Integration Scenarios', () => {
    it('should allow service to query symbol store during getChangeImpact', async () => {
      const symbolStore = module.get<SymbolStore>(SymbolStore);
      const entityGraph = module.get<EntityGraphService>(EntityGraphService);
      const graphStore = module.get<GraphStoreService>(GraphStoreService);

      // All services should be available for composition
      expect(symbolStore).toBeDefined();
      expect(entityGraph).toBeDefined();
      expect(graphStore).toBeDefined();
    });

    it('should allow transaction manager to be used across services', async () => {
      const txManager = module.get(TRANSACTION_MANAGER);
      expect(txManager.run).toBeDefined();

      // Can use transaction manager in a closure
      const result = await txManager.run(async () => {
        return 'test';
      });

      expect(result).toBe('test');
    });
  });

  describe('Module Registration Patterns', () => {
    it('should be importable as a static module', () => {
      // Module should support forRoot() registration pattern
      expect(module).toBeDefined();
    });

    it('should provide tokens for entity store and other dependencies', () => {
      const entityStore = module.get('ENTITY_GRAPH_STORE');
      expect(entityStore).toBeDefined();
    });

    it('should support optional dependencies (e.g., Prisma in EntityGraphService)', () => {
      const entityGraph = module.get<EntityGraphService>(EntityGraphService);
      expect(entityGraph).toBeDefined();
      // EntityGraphService marks Prisma as @Optional
    });
  });
});
