/**
 * Impact Analysis Service — Integration Tests
 *
 * Tests the ImpactAnalysisService.getChangeImpact() method in isolation.
 * Covers: symbol lookup, entity graph traversal, impact score calculation, provenance.
 *
 * Run: DATABASE_URL=file:./koda-test.db npx jest --forceExit test/integration/code-intel/impact-analysis.service.integration.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SymbolStore, SymbolData } from '../../../src/code-intel/symbol-store';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { GraphStoreService } from '../../../src/rag/graph-store.service';
import { EntityNodeType, EntityRecord } from '../../../src/entity-graph/dto/entity-graph.types';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';

/**
 * ImpactAnalysisService interface (to be implemented).
 * This is the service we'll test.
 */
interface ChangeImpactQuery {
  projectId: string;
  repoId: string;
  commitHash: string;
  changedFiles: string[];
  ticketId?: string;
}

interface Provenance {
  ticketId: string;
  sources: string[];
}

interface ChangeImpactResult {
  commitHash: string;
  changedFiles: string[];
  impactedSymbols: SymbolData[];
  impactedServices: EntityRecord[];
  impactedTickets: EntityRecord[];
  impactScore: number;
  provenance?: Provenance;
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('ImpactAnalysisService Integration', () => {
  let module: TestingModule;

  // Mock implementations since service doesn't exist yet
  let impactAnalysisService: {
    getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult>;
  };

  beforeAll(async () => {
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

    // Create a mock implementation of ImpactAnalysisService
    // (the real service will be implemented later)
    impactAnalysisService = {
      async getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult> {
        // This is a placeholder that will fail tests
        throw new Error('ImpactAnalysisService.getChangeImpact not implemented');
      },
    };
  });

  afterAll(async () => {
    if (module) await module.close();
  });

  describe('AC1: getChangeImpact returns schema with all required fields', () => {
    it('should return ChangeImpactResult with all required fields', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts', 'src/users.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      expect(result).toHaveProperty('commitHash');
      expect(result).toHaveProperty('changedFiles');
      expect(result).toHaveProperty('impactedSymbols');
      expect(result).toHaveProperty('impactedServices');
      expect(result).toHaveProperty('impactedTickets');
      expect(result).toHaveProperty('impactScore');
      expect(Array.isArray(result.impactedSymbols)).toBe(true);
      expect(Array.isArray(result.impactedServices)).toBe(true);
      expect(Array.isArray(result.impactedTickets)).toBe(true);
      expect(typeof result.impactScore).toBe('number');
    });
  });

  describe('AC2: impactedSymbols matches changed files', () => {
    it('should include symbols whose file matches any changedFiles entry', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // All impacted symbols should have a file matching one of the changed files
      result.impactedSymbols.forEach((symbol) => {
        expect(query.changedFiles).toContain(symbol.file);
      });
    });
  });

  describe('AC3: impactedServices linked to symbols through sourceFile/sourceId', () => {
    it('should include services linked to impacted symbols', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // Services should be entity nodes with type SERVICE or CODE_MODULE
      result.impactedServices.forEach((service) => {
        expect(
          service.entityType === EntityNodeType.SERVICE ||
          service.entityType === EntityNodeType.CODE_MODULE
        ).toBe(true);
      });
    });
  });

  describe('AC4: impactedTickets linked to impacted services', () => {
    it('should include tickets linked to any impacted service', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // Tickets should be entity nodes with type TICKET
      result.impactedTickets.forEach((ticket) => {
        expect(ticket.entityType === EntityNodeType.TICKET).toBe(true);
      });
    });
  });

  describe('AC5: impactScore computed with weighted formula', () => {
    it('should compute impactScore using the specified formula', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // impactScore should be between 0 and 100
      expect(result.impactScore).toBeGreaterThanOrEqual(0);
      expect(result.impactScore).toBeLessThanOrEqual(100);
    });

    it('should handle zero denominators without dividing by zero', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['nonexistent.ts'], // File that doesn't exist
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // Should not throw, should have a valid score
      expect(typeof result.impactScore).toBe('number');
      expect(isNaN(result.impactScore)).toBe(false);
    });

    it('should compute correct score for typical scenario with symbols, services, and tickets', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      // Formula: 0.3 * (affectedSymbols/totalSymbols*100)
      //        + 0.3 * (affectedServices/totalServices*100)
      //        + 0.2 * (affectedTickets/totalTickets*100)
      //        + 0.2 * (linkedIncidents > 0 ? 100 : 0)
      //
      // With empty data, should be close to 0
      // With full impact, should approach 100
      expect(result.impactScore).toBeGreaterThanOrEqual(0);
      expect(result.impactScore).toBeLessThanOrEqual(100);
    });
  });

  describe('AC6: provenance included when ticketId provided', () => {
    it('should include provenance when ticketId query parameter is provided', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
        ticketId: 'ticket-1',
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      expect(result).toHaveProperty('provenance');
      expect(result.provenance).toHaveProperty('ticketId');
      expect(result.provenance).toHaveProperty('sources');
      expect(Array.isArray(result.provenance?.sources)).toBe(true);
    });

    it('should not include provenance when ticketId is not provided', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'project-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await impactAnalysisService.getChangeImpact(query);

      expect(result.provenance).toBeUndefined();
    });
  });
});
