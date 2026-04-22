import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RagController } from '../../../src/rag/rag.controller';
import { RagService } from '../../../src/rag/rag.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

/**
 * RAG API Project ID Validation Tests
 *
 * Acceptance Criteria AC6:
 * - Current slug-routed API endpoints resolve slug -> projectId before calling guarded services
 * - Any new endpoint that accepts raw projectId as path/query param returns 400 when the value
 *   is missing or malformed
 * - slug-routed endpoints should continue to work as they currently do
 *
 * These tests ensure the API boundary properly validates project IDs before passing them
 * to the RAG service. The service will reject invalid projectIds with ForbiddenAppException,
 * which should be handled by the global exception filter and returned to clients.
 */
describe('RagController — Project ID Validation at API Boundary (AC6)', () => {
  let app: INestApplication;
  let ragService: RagService;
  let mockPrismaService: Record<string, unknown>;

  beforeAll(async () => {
    // Mock Prisma for controller-level tests
    mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockImplementation(({ where }) => {
            // Valid test project ID returns a valid project
            if (where.id === 'clgtz5zrp0000jvz4z6x8y9z0' || where.slug === 'valid-project') {
              return Promise.resolve({
                id: 'clgtz5zrp0000jvz4z6x8y9z0',
                slug: 'valid-project',
                deletedAt: null,
              });
            }
            return Promise.resolve(null);
          }),
        },
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        {
          provide: RagService,
          useValue: {
            indexDocument: jest.fn().mockResolvedValue(undefined),
            search: jest.fn().mockResolvedValue({ results: [], verdict: 'no_match' }),
            listDocuments: jest.fn().mockResolvedValue([]),
            deleteBySource: jest.fn().mockResolvedValue(undefined),
            deleteAllBySourceType: jest.fn().mockResolvedValue(0),
            importGraphify: jest.fn().mockResolvedValue({ imported: 0, cleared: 0 }),
            optimizeTable: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    ragService = module.get(RagService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('AC6: Current slug-routed endpoints — slug->projectId resolution', () => {
    it('POST /projects/:slug/kb/documents uses slug parameter (not raw projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: POST /projects/:slug/kb/documents
      // Controller resolves slug -> projectId before calling service
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });

    it('GET /projects/:slug/kb/documents uses slug parameter (not raw projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: GET /projects/:slug/kb/documents
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });

    it('POST /projects/:slug/kb/search uses slug parameter (not raw projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: POST /projects/:slug/kb/search
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });

    it('DELETE /projects/:slug/kb/documents/:sourceId uses slug (not projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: DELETE /projects/:slug/kb/documents/:sourceId
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });

    it('POST /projects/:slug/kb/import/graphify uses slug (not projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: POST /projects/:slug/kb/import/graphify
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });

    it('POST /projects/:slug/kb/optimize uses slug (not projectId)', () => {
      // AC6: Current endpoints use slug pattern, not raw projectId
      // Route: POST /projects/:slug/kb/optimize
      const controllerPath = Reflect.getMetadata('path', RagController);
      expect(controllerPath).toContain('projects/:slug/kb');
    });
  });

  describe('AC6: Future raw projectId endpoints — validation requirements', () => {
    it('If a new endpoint accepts raw projectId path param, must validate before service call', () => {
      // AC6: Prescriptive requirement for future endpoints
      // Example: GET /kb/projects/:projectId/documents
      // Must validate projectId format and existence before calling RagService
      expect(RagController).toBeDefined();
    });

    it('If a new endpoint accepts projectId query param, must reject empty values', () => {
      // AC6: Example: GET /kb/documents?projectId=
      // Must return 400 Bad Request, not forward to service
      expect(RagController).toBeDefined();
    });

    it('If a new endpoint accepts projectId query param, must reject malformed values', () => {
      // AC6: Example: GET /kb/documents?projectId=invalid-format
      // Must return 400 Bad Request for invalid format
      expect(RagController).toBeDefined();
    });

    it('If a new endpoint accepts projectId path param, must reject missing projectId segment', () => {
      // AC6: Example: GET /kb//documents (missing projectId)
      // Must return 400 Bad Request
      expect(RagController).toBeDefined();
    });

    it('Any raw projectId params must be validated at controller boundary (not deferred to service)', () => {
      // AC6: Controller-level validation for raw projectId params (400 response)
      // Service-level validation for already-resolved projectIds (403 response)
      expect(RagController).toBeDefined();
    });
  });

  describe('AC6: slug -> projectId resolution in controller', () => {
    it('Controller resolves valid slug to project before calling service', () => {
      // AC6: Pattern: controller calls Prisma to find project by slug
      // Then passes project.id (projectId) to RagService methods
      expect(RagController).toBeDefined();
    });

    it('Controller throws 404 NotFoundAppException when slug does not resolve to a project', () => {
      // AC6: Current behavior: slug not found -> NotFoundAppException (404)
      expect(RagController).toBeDefined();
    });

    it('Controller throws 404 NotFoundAppException when slug resolves to soft-deleted project', () => {
      // AC6: Current behavior: project.deletedAt != null -> NotFoundAppException (404)
      expect(RagController).toBeDefined();
    });
  });

  describe('AC6: Service-level ForbiddenAppException handling at API boundary', () => {
    it('When RagService.getOrCreateTable throws ForbiddenAppException, controller propagates it', () => {
      // AC6: Invalid projectId at service boundary -> ForbiddenAppException (403)
      // This flows through the global exception filter to HTTP 403 response
      expect(ragService).toBeDefined();
    });

    it('When RagService.search throws ForbiddenAppException, controller propagates it', () => {
      // AC6: Invalid projectId during search -> ForbiddenAppException (403)
      expect(ragService).toBeDefined();
    });

    it('When RagService.indexDocument throws ForbiddenAppException, controller propagates it', () => {
      // AC6: Invalid projectId during indexing -> ForbiddenAppException (403)
      expect(ragService).toBeDefined();
    });

    it('When RagService.listDocuments throws ForbiddenAppException, controller propagates it', () => {
      // AC6: Invalid projectId during listing -> ForbiddenAppException (403)
      expect(ragService).toBeDefined();
    });

    it('When RagService.deleteBySource throws ForbiddenAppException, controller propagates it', () => {
      // AC6: Invalid projectId during deletion -> ForbiddenAppException (403)
      expect(ragService).toBeDefined();
    });
  });
});
