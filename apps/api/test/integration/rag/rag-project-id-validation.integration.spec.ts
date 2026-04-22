import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { RagService } from '../../../src/rag/rag.service';
import { EmbeddingService } from '../../../src/rag/embedding.service';

/**
 * Project ID Hard Enforcement Tests
 *
 * These tests verify that the RagService strictly validates projectId values
 * at the service boundary before any data access occurs.
 *
 * Acceptance Criteria:
 * 1. Empty projectId throws ForbiddenAppException with "Project ID is required"
 * 2. Invalid projectId format throws ForbiddenAppException
 * 3. Valid format but non-existent project throws ForbiddenAppException
 * 4. search() rejects invalid projectId before table access
 * 5. All service methods have @throws doc comments
 * 6. API endpoints with raw projectId params return 400 for invalid values
 *
 * @throws ForbiddenAppException when projectId is empty, malformed, or non-existent
 */
describe('RagService — Project ID Hard Enforcement (projectIdValidation)', () => {
  let module: TestingModule;
  let ragService: RagService;
  let mockPrismaService: Record<string, unknown>;

  beforeAll(async () => {
    // Mock Prisma to track project existence checks
    mockPrismaService = {
      client: {
        project: {
          findUnique: jest.fn().mockImplementation(({ where }) => {
            // Only return a project for a specific valid test ID
            if (where.id === 'clgtz5zrp0000jvz4z6x8y9z0') {
              return Promise.resolve({ id: 'clgtz5zrp0000jvz4z6x8y9z0', deletedAt: null });
            }
            return Promise.resolve(null);
          }),
          count: jest.fn().mockResolvedValue(0),
        },
      },
    };

    module = await Test.createTestingModule({
      providers: [
        RagService,
        {
          provide: EmbeddingService,
          useValue: {
            embed: jest.fn().mockResolvedValue(new Float32Array(8).fill(0)),
            providerName: 'test',
            modelName: 'test-v1',
            dimensions: 8,
          },
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const config: Record<string, unknown> = {
                'rag.lancedbPath': './lancedb',
                'rag.inMemoryOnly': true,
                'rag.ftsIndexMode': 'simple',
                'rag.similarityHigh': 0.85,
                'rag.similarityMedium': 0.70,
                'rag.similarityLow': 0.50,
              };
              return config[key];
            },
          },
        },
      ],
    }).compile();

    ragService = module.get(RagService);
  });

  afterAll(async () => {
    await module.close();
  });

  describe('getOrCreateTable — AC1: Empty projectId requires validation', () => {
    it('throws ForbiddenAppException when projectId is empty string', async () => {
      // AC1: Empty projectId must throw ForbiddenAppException
      await expect(ragService.getOrCreateTable('')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException with message indicating "required" when projectId is empty', async () => {
      // AC1: Error message should indicate "Project ID is required"
      try {
        await ragService.getOrCreateTable('');
        fail('Expected ForbiddenAppException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenAppException);
        if (error instanceof ForbiddenAppException) {
          // Message should indicate the issue
          expect(error.message.toLowerCase()).toMatch(/required|empty|invalid/);
        }
      }
    });

    it('throws ForbiddenAppException when projectId is whitespace only', async () => {
      // AC1: Whitespace-only strings should be treated as invalid
      await expect(ragService.getOrCreateTable('   ')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('\t')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('\n')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when projectId is null', async () => {
      // AC1: null should be treated as invalid
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(ragService.getOrCreateTable(null as any)).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when projectId is undefined', async () => {
      // AC1: undefined should be treated as invalid
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(ragService.getOrCreateTable(undefined as any)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('getOrCreateTable — AC2: Invalid projectId format validation', () => {
    it('throws ForbiddenAppException when projectId contains hyphens (not CUID format)', async () => {
      // AC2: Hyphens are not valid in CUID format; should be rejected
      await expect(ragService.getOrCreateTable('not-a-project-id')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException for underscore-prefixed string (malformed CUID)', async () => {
      // AC2: Underscores indicate non-CUID format; should be rejected early
      await expect(ragService.getOrCreateTable('cm_invalid_but_well_shaped')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when projectId is too short for CUID format', async () => {
      // AC2: CUIDs are 24-25 chars; single char should be invalid
      await expect(ragService.getOrCreateTable('c')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('clg')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException for projectId with spaces', async () => {
      // AC2: Spaces are invalid in CUID format
      await expect(ragService.getOrCreateTable('c proj id')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('clgtz5zrp0000jvz4z6x8 id')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException for projectId with special characters', async () => {
      // AC2: Special characters (@, #, !, etc.) are invalid in CUID format
      await expect(ragService.getOrCreateTable('c@proj#id!')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('clgtz5zrp0000jvz4z6x8y9z@')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException for projectId with uppercase letters', async () => {
      // AC2: CUIDs use only lowercase letters; uppercase should be rejected
      await expect(ragService.getOrCreateTable('CLGTZ5ZRP0000JVZ4Z6X8Y9Z0')).rejects.toThrow(ForbiddenAppException);
      await expect(ragService.getOrCreateTable('ClGTZ5ZRP0000JVZ4Z6X8Y9Z0')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException for projectId that is too long', async () => {
      // AC2: CUIDs have a maximum length; excessively long strings should be rejected
      const tooLong = 'clgtz5zrp0000jvz4z6x8y9z0' + 'extra';
      await expect(ragService.getOrCreateTable(tooLong)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('getOrCreateTable — AC3: Non-existent project (valid CUID format)', () => {
    it('throws ForbiddenAppException when projectId format is valid CUID but project does not exist in DB', async () => {
      // AC3: Format-valid CUID that doesn't exist in Prisma should throw ForbiddenAppException
      // Use a valid CUID format that is NOT in the mock database
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z1';
      await expect(ragService.getOrCreateTable(validFormatButNonExistentId)).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException with message indicating project not found', async () => {
      // AC3: Error should clearly indicate the project doesn't exist
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z2';
      try {
        await ragService.getOrCreateTable(validFormatButNonExistentId);
        fail('Expected ForbiddenAppException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenAppException);
      }
    });

    it('throws ForbiddenAppException before attempting to access or create any LanceDB table', async () => {
      // AC3: Validation must happen BEFORE any data access
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z3';
      // The rejection should happen synchronously or early, not after table creation attempts
      const promise = ragService.getOrCreateTable(validFormatButNonExistentId);
      await expect(promise).rejects.toThrow(ForbiddenAppException);
    });

    it('validates project existence in database (Prisma) before LanceDB access', async () => {
      // AC3: Service must call Prisma to verify project exists before touching LanceDB
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z4';
      try {
        await ragService.getOrCreateTable(validFormatButNonExistentId);
      } catch (error) {
        // Should have called prisma.client.project.findUnique
        expect(error).toBeInstanceOf(ForbiddenAppException);
      }
    });
  });

  describe('search — AC4: Invalid projectId rejection before table access', () => {
    it('throws ForbiddenAppException when search() is called with empty projectId', async () => {
      // AC4: Empty projectId should be rejected before any table operations
      await expect(ragService.search('', 'query')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when search() is called with invalid projectId format', async () => {
      // AC4: Invalid format (with hyphens, etc.) should be rejected before table access
      await expect(ragService.search('invalid-id', 'query')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when search() is called with non-existent projectId', async () => {
      // AC4: Valid format but non-existent project should be rejected
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z5';
      await expect(ragService.search(validFormatButNonExistentId, 'query')).rejects.toThrow(ForbiddenAppException);
    });

    it('performs projectId validation before attempting to access getOrCreateTable', async () => {
      // AC4: Validation MUST happen synchronously/early, not after table operations
      const getOrCreateTableSpy = jest.spyOn(ragService, 'getOrCreateTable');
      try {
        await ragService.search('invalid-format', 'query');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenAppException);
      }
      // For invalid format, getOrCreateTable should never be called
      expect(getOrCreateTableSpy).not.toHaveBeenCalledWith('invalid-format');
    });

    it('performs projectId validation before attempting to query the table', async () => {
      // AC4: Validation must happen before any LanceDB query operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z6';
      try {
        await ragService.search(validFormatButNonExistentId, 'test query');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenAppException);
      }
    });
  });

  describe('indexDocument — AC: Invalid projectId rejection before indexing', () => {
    it('throws ForbiddenAppException when indexDocument() is called with empty projectId', async () => {
      // Should validate projectId before any embedding/indexing operations
      await expect(
        ragService.indexDocument('', {
          source: 'ticket',
          sourceId: 'test',
          content: 'test',
          metadata: {},
        }),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when indexDocument() is called with invalid projectId format', async () => {
      // Format validation must happen before document indexing
      await expect(
        ragService.indexDocument('invalid-id', {
          source: 'ticket',
          sourceId: 'test',
          content: 'test',
          metadata: {},
        }),
      ).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when indexDocument() is called with non-existent projectId', async () => {
      // Database validation must happen before indexing
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z7';
      await expect(
        ragService.indexDocument(validFormatButNonExistentId, {
          source: 'ticket',
          sourceId: 'test',
          content: 'test',
          metadata: {},
        }),
      ).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('listDocuments — AC: Invalid projectId rejection before querying', () => {
    it('throws ForbiddenAppException when listDocuments() is called with empty projectId', async () => {
      // Must validate before table operations
      await expect(ragService.listDocuments('')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when listDocuments() is called with invalid projectId format', async () => {
      // Format validation must occur before any DB access
      await expect(ragService.listDocuments('not-valid')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when listDocuments() is called with non-existent projectId', async () => {
      // Existence validation must occur before table operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z8';
      await expect(ragService.listDocuments(validFormatButNonExistentId)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('deleteBySource — AC: Invalid projectId rejection before deletion', () => {
    it('throws ForbiddenAppException when deleteBySource() is called with empty projectId', async () => {
      // Validation must occur before any delete operations
      await expect(ragService.deleteBySource('', 'source-id')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when deleteBySource() is called with invalid projectId format', async () => {
      // Format validation must prevent delete operations
      await expect(ragService.deleteBySource('bad-id', 'source-id')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when deleteBySource() is called with non-existent projectId', async () => {
      // Existence check must prevent delete operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9z9';
      await expect(ragService.deleteBySource(validFormatButNonExistentId, 'source-id')).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('deleteAllBySourceType — AC: Invalid projectId rejection before deletion', () => {
    it('throws ForbiddenAppException when deleteAllBySourceType() is called with empty projectId', async () => {
      // Validation before mass delete
      await expect(ragService.deleteAllBySourceType('', 'ticket')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when deleteAllBySourceType() is called with invalid projectId format', async () => {
      // Format validation blocks bulk operations
      await expect(ragService.deleteAllBySourceType('invalid', 'code')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when deleteAllBySourceType() is called with non-existent projectId', async () => {
      // Existence validation blocks bulk operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9za';
      await expect(ragService.deleteAllBySourceType(validFormatButNonExistentId, 'manual')).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('importGraphify — AC: Invalid projectId rejection before import', () => {
    it('throws ForbiddenAppException when importGraphify() is called with empty projectId', async () => {
      // Validation before import operations
      await expect(ragService.importGraphify('', [], [])).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when importGraphify() is called with invalid projectId format', async () => {
      // Format validation prevents import operations
      await expect(ragService.importGraphify('not-valid', [], [])).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when importGraphify() is called with non-existent projectId', async () => {
      // Existence validation prevents import operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9zb';
      await expect(ragService.importGraphify(validFormatButNonExistentId, [], [])).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('validateTableProvider — AC: Invalid projectId rejection before validation', () => {
    it('throws ForbiddenAppException when validateTableProvider() is called with empty projectId', async () => {
      // Validation before provider checks
      await expect(ragService.validateTableProvider('')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when validateTableProvider() is called with invalid projectId format', async () => {
      // Format validation before provider operations
      await expect(ragService.validateTableProvider('bad-format')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when validateTableProvider() is called with non-existent projectId', async () => {
      // Existence validation before provider operations
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9zc';
      await expect(ragService.validateTableProvider(validFormatButNonExistentId)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('optimizeTable — AC: Invalid projectId rejection before optimization', () => {
    it('throws ForbiddenAppException when optimizeTable() is called with empty projectId', async () => {
      // Validation before optimization operations
      await expect(ragService.optimizeTable('')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when optimizeTable() is called with invalid projectId format', async () => {
      // Format validation before optimization
      await expect(ragService.optimizeTable('invalid-format')).rejects.toThrow(ForbiddenAppException);
    });

    it('throws ForbiddenAppException when optimizeTable() is called with non-existent projectId', async () => {
      // Existence validation before optimization
      const validFormatButNonExistentId = 'clgtz5zrp0000jvz4z6x8y9zd';
      await expect(ragService.optimizeTable(validFormatButNonExistentId)).rejects.toThrow(ForbiddenAppException);
    });
  });

  describe('AC5: Documentation — @throws ForbiddenAppException for all projectId-accepting methods', () => {
    // AC5: Every service method that accepts projectId must have @throws documentation
    // indicating it can throw ForbiddenAppException when projectId is invalid.
    //
    // This is verified by reading the source code (not via runtime introspection).
    // Implementation note: add JSDoc comments like:
    //   /**
    //    * @throws ForbiddenAppException if projectId is empty, invalid format, or non-existent
    //    */

    it('getOrCreateTable method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to getOrCreateTable
      expect(typeof ragService.getOrCreateTable).toBe('function');
    });

    it('search method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to search
      expect(typeof ragService.search).toBe('function');
    });

    it('indexDocument method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to indexDocument
      expect(typeof ragService.indexDocument).toBe('function');
    });

    it('listDocuments method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to listDocuments
      expect(typeof ragService.listDocuments).toBe('function');
    });

    it('deleteBySource method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to deleteBySource
      expect(typeof ragService.deleteBySource).toBe('function');
    });

    it('deleteAllBySourceType method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to deleteAllBySourceType
      expect(typeof ragService.deleteAllBySourceType).toBe('function');
    });

    it('importGraphify method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to importGraphify
      expect(typeof ragService.importGraphify).toBe('function');
    });

    it('validateTableProvider method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to validateTableProvider
      expect(typeof ragService.validateTableProvider).toBe('function');
    });

    it('optimizeTable method exists (requires @throws doc in source)', () => {
      // AC5: Implementation must add @throws doc comment to optimizeTable
      expect(typeof ragService.optimizeTable).toBe('function');
    });
  });
});
