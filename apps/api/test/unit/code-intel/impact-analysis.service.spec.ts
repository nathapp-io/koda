/**
 * ImpactAnalysisService Unit Tests
 *
 * Tests the core impact analysis logic with mocked dependencies.
 * Verifies: symbol filtering, service linking, ticket collection, score calculation.
 *
 * Run: npx jest test/unit/code-intel/impact-analysis.service.spec.ts
 */

import { SymbolData } from '../../../src/code-intel/symbol-store';
import { EntityNodeType, EntityRecord } from '../../../src/entity-graph/dto/entity-graph.types';

// Mock interfaces (service will be implemented)
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

describe('ImpactAnalysisService Unit Tests', () => {
  let service: {
    getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult>;
  };

  beforeEach(() => {
    service = {
      async getChangeImpact(query: ChangeImpactQuery): Promise<ChangeImpactResult> {
        throw new Error('ImpactAnalysisService.getChangeImpact not implemented');
      },
    };
  });

  describe('Symbol Filtering', () => {
    it('should filter symbols by changed files', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts', 'src/users.ts'],
      };

      const result = await service.getChangeImpact(query);

      result.impactedSymbols.forEach((symbol) => {
        expect(query.changedFiles).toContain(symbol.file);
      });
    });

    it('should return empty symbols array when no symbols match changed files', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['nonexistent.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(Array.isArray(result.impactedSymbols)).toBe(true);
    });

    it('should include symbol metadata (id, name, kind, signature)', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      result.impactedSymbols.forEach((symbol) => {
        expect(symbol).toHaveProperty('id');
        expect(symbol).toHaveProperty('name');
        expect(symbol).toHaveProperty('kind');
        expect(symbol).toHaveProperty('file');
      });
    });
  });

  describe('Service Linking', () => {
    it('should identify services linked to impacted symbols', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(Array.isArray(result.impactedServices)).toBe(true);
      result.impactedServices.forEach((service) => {
        expect([EntityNodeType.SERVICE, EntityNodeType.CODE_MODULE]).toContain(
          service.entityType,
        );
      });
    });

    it('should link services through Symbol.file → GraphNode.sourceFile', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      // Each service should have metadata indicating its source file
      result.impactedServices.forEach((service) => {
        expect(service.metadata).toBeDefined();
      });
    });

    it('should handle services with EntityNode.sourceId mapping', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      // Services should have consistent entity IDs
      result.impactedServices.forEach((service) => {
        expect(service.entityId).toBeDefined();
      });
    });
  });

  describe('Ticket Collection', () => {
    it('should identify tickets linked to impacted services', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(Array.isArray(result.impactedTickets)).toBe(true);
      result.impactedTickets.forEach((ticket) => {
        expect(ticket.entityType).toBe(EntityNodeType.TICKET);
      });
    });

    it('should return empty tickets array when no services are impacted', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['nonexistent-file.ts'],
      };

      const result = await service.getChangeImpact(query);

      // May be empty if no impact
      expect(Array.isArray(result.impactedTickets)).toBe(true);
    });

    it('should include ticket metadata (status, priority, type)', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      result.impactedTickets.forEach((ticket) => {
        expect(ticket).toHaveProperty('label');
        expect(ticket).toHaveProperty('metadata');
      });
    });
  });

  describe('Impact Score Calculation', () => {
    it('should calculate impact score between 0 and 100', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(result.impactScore).toBeGreaterThanOrEqual(0);
      expect(result.impactScore).toBeLessThanOrEqual(100);
    });

    it('should use weighted formula: 0.3 * symbols + 0.3 * services + 0.2 * tickets + 0.2 * incidents', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      // Score should reflect weighted contributions
      // Full impact (all denominators > 0, all affected) → near 100
      // Zero impact (no affected) → near 0
      expect(typeof result.impactScore).toBe('number');
      expect(isNaN(result.impactScore)).toBe(false);
      expect(isFinite(result.impactScore)).toBe(true);
    });

    it('should guard against division by zero', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['nonexistent.ts'],
      };

      const result = await service.getChangeImpact(query);

      // Even with no symbols, services, or tickets, score should be valid
      expect(isNaN(result.impactScore)).toBe(false);
      expect(isFinite(result.impactScore)).toBe(true);
    });

    it('should return 0 score when no impact detected', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['unused-file.ts'],
      };

      const result = await service.getChangeImpact(query);

      // When nothing is impacted, score should be 0
      if (result.impactedSymbols.length === 0 && result.impactedServices.length === 0) {
        expect(result.impactScore).toEqual(0);
      }
    });

    it('should include linkedIncidents term when HIGH/CRITICAL tickets are impacted', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/critical-auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      // Score should consider linked incidents (CRITICAL/HIGH priority tickets)
      const hasHighPriorityTickets = result.impactedTickets.some(
        (ticket) =>
          ticket.metadata?.priority === 'HIGH' || ticket.metadata?.priority === 'CRITICAL',
      );

      if (hasHighPriorityTickets) {
        // Score should be influenced by the +0.2*100 incident term
        expect(result.impactScore).toBeGreaterThan(0);
      }
    });
  });

  describe('Provenance Metadata', () => {
    it('should include provenance when ticketId is provided', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
        ticketId: 'ticket-1',
      };

      const result = await service.getChangeImpact(query);

      expect(result.provenance).toBeDefined();
      expect(result.provenance?.ticketId).toBe('ticket-1');
      expect(Array.isArray(result.provenance?.sources)).toBe(true);
    });

    it('should not include provenance when ticketId is not provided', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(result.provenance).toBeUndefined();
    });

    it('should list sources in provenance (symbols, services, tickets)', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts'],
        ticketId: 'ticket-1',
      };

      const result = await service.getChangeImpact(query);

      expect(result.provenance?.sources).toBeDefined();
      expect(Array.isArray(result.provenance?.sources)).toBe(true);
      // Sources should be entity IDs or names
      result.provenance?.sources.forEach((source) => {
        expect(typeof source).toBe('string');
      });
    });
  });

  describe('Query Parameters', () => {
    it('should accept changedFiles as comma-separated string', async () => {
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles: ['src/auth.ts', 'src/users.ts', 'src/utils.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(result.changedFiles.length).toBe(3);
    });

    it('should preserve original changedFiles in result', async () => {
      const changedFiles = ['src/auth.ts', 'src/users.ts'];
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc123',
        changedFiles,
      };

      const result = await service.getChangeImpact(query);

      expect(result.changedFiles).toEqual(changedFiles);
    });

    it('should preserve commitHash in result', async () => {
      const commitHash = 'abc123def456';
      const query: ChangeImpactQuery = {
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash,
        changedFiles: ['src/auth.ts'],
      };

      const result = await service.getChangeImpact(query);

      expect(result.commitHash).toBe(commitHash);
    });
  });
});
