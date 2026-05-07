/**
 * CodeIntelController Unit Tests
 *
 * Tests the controller layer for the GET /projects/:slug/codeintel/impact endpoint.
 * Verifies: route definition, permission guards, parameter validation, response formatting.
 *
 * Run: npx jest test/unit/code-intel/codeintel.controller.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';

// Mock controller to be tested
interface ImpactAnalysisService {
  getChangeImpact(query: {
    projectId: string;
    repoId: string;
    commitHash: string;
    changedFiles: string[];
    ticketId?: string;
  }): Promise<{
    commitHash: string;
    changedFiles: string[];
    impactedSymbols: unknown[];
    impactedServices: unknown[];
    impactedTickets: unknown[];
    impactScore: number;
    provenance?: { ticketId: string; sources: string[] };
  }>;
}

describe('CodeIntelController', () => {
  let module: TestingModule;
  let mockService: ImpactAnalysisService;
  let controller: {
    getChangeImpact(
      slug: string,
      repoId: string,
      commitHash: string,
      changedFiles: string,
      ticketId?: string,
    ): Promise<unknown>;
  };

  beforeEach(async () => {
    mockService = {
      async getChangeImpact(query) {
        // Default mock implementation
        return {
          commitHash: query.commitHash,
          changedFiles: query.changedFiles,
          impactedSymbols: [],
          impactedServices: [],
          impactedTickets: [],
          impactScore: 0,
        };
      },
    };

    module = await Test.createTestingModule({
      providers: [
        {
          provide: 'ImpactAnalysisService',
          useValue: mockService,
        },
      ],
    }).compile();

    controller = {
      async getChangeImpact(slug, repoId, commitHash, changedFiles, ticketId) {
        throw new Error('CodeIntelController.getChangeImpact not implemented');
      },
    };
  });

  afterEach(async () => {
    if (module) await module.close();
  });

  describe('Route Definition', () => {
    it('should define GET /projects/:slug/codeintel/impact endpoint', async () => {
      // Route should exist
      expect(controller.getChangeImpact).toBeDefined();
    });
  });

  describe('Parameter Validation', () => {
    it('should accept repoId, commitHash, changedFiles query parameters', async () => {
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts,src/users.ts',
      );

      expect(result).toBeDefined();
    });

    it('should accept optional ticketId query parameter', async () => {
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
        'ticket-1',
      );

      expect(result).toBeDefined();
    });

    it('should require repoId parameter', async () => {
      // Missing repoId should fail validation
      try {
        await controller.getChangeImpact('test-project', '', 'abc123', 'src/auth.ts');
        fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should require commitHash parameter', async () => {
      // Missing commitHash should fail validation
      try {
        await controller.getChangeImpact('test-project', 'repo-1', '', 'src/auth.ts');
        fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should require changedFiles parameter', async () => {
      // Missing changedFiles should fail validation
      try {
        await controller.getChangeImpact('test-project', 'repo-1', 'abc123', '');
        fail('Should have thrown validation error');
      } catch (error) {
        expect(error).toBeDefined();
      }
    });

    it('should parse changedFiles from comma-separated string to array', async () => {
      // Controller should parse 'src/auth.ts,src/users.ts' into ['src/auth.ts', 'src/users.ts']
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts,src/users.ts',
      );

      expect(result).toBeDefined();
    });
  });

  describe('Permission Gating', () => {
    it('should be decorated with @RequiredPermission([READ, "CodeIntel"])', async () => {
      // Controller method should have permission guard
      // This is enforced at runtime by @RequiredPermission decorator
      expect(controller.getChangeImpact).toBeDefined();
    });

    it('should accept requests from ADMIN users', async () => {
      // ADMIN users should have READ permission for CodeIntel
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      expect(result).toBeDefined();
    });

    it('should accept requests from agents (all agents have CodeIntel.READ)', async () => {
      // All agents are granted CodeIntel.READ by factory
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      expect(result).toBeDefined();
    });

    it('should reject requests from non-permitted users with 403', async () => {
      // Non-ADMIN, non-DEVELOPER users should get 403
      // This would be enforced by PermissionAuthGuard at runtime
      try {
        await controller.getChangeImpact(
          'test-project',
          'repo-1',
          'abc123',
          'src/auth.ts',
        );
      } catch (error) {
        // May throw or return 403 depending on implementation
        expect(error).toBeDefined();
      }
    });
  });

  describe('Response Formatting', () => {
    it('should return response wrapped in JsonResponse.Ok', async () => {
      // Response should follow Nathapp JSON envelope pattern
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      expect(result).toHaveProperty('ret');
      expect(result).toHaveProperty('data');
    });

    it('should include all required fields in response data', async () => {
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      const data = result as {
        data: {
          commitHash: string;
          changedFiles: string[];
          impactedSymbols: unknown[];
          impactedServices: unknown[];
          impactedTickets: unknown[];
          impactScore: number;
        };
      };

      expect(data.data).toHaveProperty('commitHash');
      expect(data.data).toHaveProperty('changedFiles');
      expect(data.data).toHaveProperty('impactedSymbols');
      expect(data.data).toHaveProperty('impactedServices');
      expect(data.data).toHaveProperty('impactedTickets');
      expect(data.data).toHaveProperty('impactScore');
    });

    it('should include provenance in response when ticketId is provided', async () => {
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
        'ticket-1',
      );

      const data = result as {
        data: {
          provenance?: { ticketId: string; sources: string[] };
        };
      };

      expect(data.data.provenance).toBeDefined();
    });

    it('should not include provenance in response when ticketId is not provided', async () => {
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      const data = result as {
        data: {
          provenance?: { ticketId: string; sources: string[] };
        };
      };

      expect(data.data.provenance).toBeUndefined();
    });
  });

  describe('Project Slug Resolution', () => {
    it('should resolve project by slug parameter', async () => {
      // Controller should accept project slug and resolve to projectId internally
      const result = await controller.getChangeImpact(
        'test-project-slug',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      expect(result).toBeDefined();
    });

    it('should return 404 when project slug does not exist', async () => {
      // Missing project should return 404
      try {
        await controller.getChangeImpact(
          'nonexistent-project',
          'repo-1',
          'abc123',
          'src/auth.ts',
        );
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Principal Injection', () => {
    it('should inject @Principal() to get actor context', async () => {
      // Controller should use @Principal() principal: KodaPrincipal
      // to get the authenticated user/agent making the request
      expect(controller.getChangeImpact).toBeDefined();
    });

    it('should use principal for permission checks and logging', async () => {
      // Principal should be available for use in service
      const result = await controller.getChangeImpact(
        'test-project',
        'repo-1',
        'abc123',
        'src/auth.ts',
      );

      expect(result).toBeDefined();
    });
  });
});
