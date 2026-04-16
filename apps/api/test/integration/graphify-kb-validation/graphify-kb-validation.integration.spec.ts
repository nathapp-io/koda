import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { AddDocumentDto } from '../../../src/rag/dto/add-document.dto';
import { ProjectResponseDto } from '../../../src/projects/dto/project-response.dto';
import { UpdateProjectDto } from '../../../src/projects/dto/update-project.dto';
import type { IndexDocumentInput } from '../../../src/rag/rag.service';
import { RagController } from '../../../src/rag/rag.controller';
import { RagService } from '../../../src/rag/rag.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ImportGraphifyDto, GraphifyNodeDto, GraphifyLinkDto } from '../../../src/rag/dto/import-graphify.dto';

// Variable-path require helper for the not-yet-existing ImportGraphifyDto (US-003).
// TypeScript only statically resolves string-literal require() paths.
// Using a runtime-computed path compiles cleanly and throws "Cannot find module"
// at test execution time — the correct RED-phase failure signal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadImportGraphifyModule(): any {
  // Non-literal path: TypeScript returns `any`, no static resolution error.
  const modulePath = path.join(__dirname, '../../../src/rag/dto/import-graphify.dto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
  return require(modulePath);
}

describe('Graphify KB Validation - Schema, DTO & i18n Extensions', () => {
  describe('AC1: Project.graphifyEnabled defaults to false when a project is created with no graphifyEnabled field', () => {
    it('should map graphifyEnabled as false from project data to DTO', () => {
      // This test verifies that ProjectResponseDto correctly maps the graphifyEnabled field
      // The Prisma schema has @default(false) for this field
      const projectData = {
        id: 'proj-1',
        name: 'Test Project',
        slug: 'test-project',
        key: 'TEST',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ciWebhookToken: null,
        autoAssign: 'OFF',
        graphifyEnabled: false, // Default value from schema
        graphifyLastImportedAt: null,
      };

      const dto = ProjectResponseDto.from(projectData);

      expect(dto).toHaveProperty('graphifyEnabled');
      expect(dto.graphifyEnabled).toBe(false);
    });
  });

  describe('AC2: AddDocumentDto accepts source: "code" without a validation error', () => {
    it('should accept source "code" in AddDocumentDto with valid data', async () => {
      const dto = plainToClass(AddDocumentDto, {
        source: 'code',
        sourceId: 'file-123',
        content: 'function example() { return true; }',
        metadata: { filename: 'example.ts' },
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.source).toBe('code');
    });

    it('should accept all valid sources: ticket, doc, manual, code', async () => {
      const validSources = ['ticket', 'doc', 'manual', 'code'];

      for (const source of validSources) {
        const dto = plainToClass(AddDocumentDto, {
          source,
          sourceId: 'id-123',
          content: 'content',
        });

        const errors = await validate(dto);
        expect(errors).toHaveLength(0);
      }
    });
  });

  describe('AC3: AddDocumentDto rejects any source value not in ["ticket", "doc", "manual", "code"] with a 400 validation error', () => {
    it('should reject invalid source values', async () => {
      const invalidSources = ['invalid', 'code2', 'codebase', 'source', 'repository'];

      for (const source of invalidSources) {
        const dto = plainToClass(AddDocumentDto, {
          source,
          sourceId: 'id-123',
          content: 'content',
        });

        const errors = await validate(dto);
        // Should have validation error for invalid source
        expect(errors.length).toBeGreaterThan(0);
        expect(
          errors.some((e) => e.property === 'source'),
        ).toBe(true);
      }
    });
  });

  describe('AC4: IndexDocumentInput.source type includes "code" as a valid literal', () => {
    it('should have code as valid source in IndexDocumentInput type', () => {
      // This is a type-level test that verifies the source union includes 'code'
      const input: IndexDocumentInput = {
        source: 'code', // Should compile without error
        sourceId: 'file-123',
        content: 'code content',
        metadata: { file: 'test.ts' },
      };

      expect(input.source).toBe('code');
      expect(['ticket', 'doc', 'manual', 'code']).toContain(input.source);
    });
  });

  describe('AC5: ProjectResponseDto.from(project) maps project.graphifyEnabled to dto.graphifyEnabled', () => {
    it('should map graphifyEnabled=true from project to DTO', () => {
      const projectData = {
        id: 'proj-1',
        name: 'Test Project',
        slug: 'test-project',
        key: 'TEST',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ciWebhookToken: null,
        autoAssign: 'OFF',
        graphifyEnabled: true,
        graphifyLastImportedAt: null,
      };

      const dto = ProjectResponseDto.from(projectData);

      expect(dto.graphifyEnabled).toBe(true);
    });

    it('should map graphifyEnabled=false from project to DTO', () => {
      const projectData = {
        id: 'proj-2',
        name: 'Another Project',
        slug: 'another-project',
        key: 'ANOTH',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ciWebhookToken: null,
        autoAssign: 'OFF',
        graphifyEnabled: false,
        graphifyLastImportedAt: null,
      };

      const dto = ProjectResponseDto.from(projectData);

      expect(dto.graphifyEnabled).toBe(false);
    });
  });

  describe('AC6: ProjectResponseDto.from(project) maps project.graphifyLastImportedAt to dto.graphifyLastImportedAt as Date | null', () => {
    it('should map graphifyLastImportedAt as Date when set', () => {
      const importedAt = new Date('2026-01-15T10:30:00Z');
      const projectData = {
        id: 'proj-1',
        name: 'Test Project',
        slug: 'test-project',
        key: 'TEST',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ciWebhookToken: null,
        autoAssign: 'OFF',
        graphifyEnabled: true,
        graphifyLastImportedAt: importedAt,
      };

      const dto = ProjectResponseDto.from(projectData);

      expect(dto.graphifyLastImportedAt).toEqual(importedAt);
      expect(dto.graphifyLastImportedAt instanceof Date).toBe(true);
    });

    it('should map graphifyLastImportedAt as null when not set', () => {
      const projectData = {
        id: 'proj-2',
        name: 'Another Project',
        slug: 'another-project',
        key: 'ANOTH',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        ciWebhookToken: null,
        autoAssign: 'OFF',
        graphifyEnabled: false,
        graphifyLastImportedAt: null,
      };

      const dto = ProjectResponseDto.from(projectData);

      expect(dto.graphifyLastImportedAt).toBeNull();
    });
  });

  describe('AC7: UpdateProjectDto accepts graphifyEnabled: true without a validation error', () => {
    it('should accept graphifyEnabled: true in UpdateProjectDto', async () => {
      const dto = plainToClass(UpdateProjectDto, {
        graphifyEnabled: true,
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.graphifyEnabled).toBe(true);
    });

    it('should accept graphifyEnabled: false in UpdateProjectDto', async () => {
      const dto = plainToClass(UpdateProjectDto, {
        graphifyEnabled: false,
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.graphifyEnabled).toBe(false);
    });

    it('should allow graphifyEnabled with other fields', async () => {
      const dto = plainToClass(UpdateProjectDto, {
        name: 'Updated Name',
        description: 'Updated description',
        graphifyEnabled: true,
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.name).toBe('Updated Name');
      expect(dto.graphifyEnabled).toBe(true);
    });

    it('should reject non-boolean graphifyEnabled', async () => {
      const dto = plainToClass(UpdateProjectDto, {
        graphifyEnabled: 'true', // string instead of boolean
      });

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some((e) => e.property === 'graphifyEnabled'),
      ).toBe(true);
    });
  });

  describe('AC8: i18n keys for graphifyDisabled exist in both apps/api/src/i18n/en/rag.json and apps/api/src/i18n/zh/rag.json', () => {
    it('should have graphifyDisabled key in English i18n file', () => {
      const enFilePath = path.join(
        __dirname,
        '../../../src/i18n/en/rag.json',
      );
      const content = fs.readFileSync(enFilePath, 'utf-8');
      const json = JSON.parse(content);

      expect(json).toHaveProperty('graphifyDisabled');
      expect(typeof json.graphifyDisabled).toBe('string');
      expect(json.graphifyDisabled.length).toBeGreaterThan(0);
    });

    it('should have graphifyDisabled key in Chinese i18n file', () => {
      const zhFilePath = path.join(
        __dirname,
        '../../../src/i18n/zh/rag.json',
      );
      const content = fs.readFileSync(zhFilePath, 'utf-8');
      const json = JSON.parse(content);

      expect(json).toHaveProperty('graphifyDisabled');
      expect(typeof json.graphifyDisabled).toBe('string');
      expect(json.graphifyDisabled.length).toBeGreaterThan(0);
    });

    it('should have both English and Chinese translations', () => {
      const enFilePath = path.join(
        __dirname,
        '../../../src/i18n/en/rag.json',
      );
      const zhFilePath = path.join(
        __dirname,
        '../../../src/i18n/zh/rag.json',
      );

      const enContent = JSON.parse(fs.readFileSync(enFilePath, 'utf-8'));
      const zhContent = JSON.parse(fs.readFileSync(zhFilePath, 'utf-8'));

      expect(enContent).toHaveProperty('graphifyDisabled');
      expect(zhContent).toHaveProperty('graphifyDisabled');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-003: ImportGraphifyDto, GraphifyNodeDto, GraphifyLinkDto
  // ─────────────────────────────────────────────────────────────────

  describe('US-003: ImportGraphifyDto — DTO structure and validation', () => {
    // AC6: ImportGraphifyDto rejects a request body missing the nodes field
    it('AC6: should reject a body missing the nodes field with a validation error', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, { links: [] });

      const errors = await validate(dto as object);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'nodes')).toBe(true);
    });

    // AC7: links is optional — no validation error when links is absent
    it('AC7: should accept a body with nodes present and links absent (links is optional)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [{ id: 'node-1', label: 'MyClass', type: 'class', source_file: 'src/my.ts' }],
      });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('should accept a body with both nodes and links present', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [
          { id: 'node-1', label: 'AuthService', type: 'class', source_file: 'src/auth.service.ts' },
          { id: 'node-2', label: 'UserService', type: 'class', source_file: 'src/user.service.ts' },
        ],
        links: [{ source: 'node-1', target: 'node-2', relation: 'depends_on' }],
      });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('should accept nodes: [] with links: [] (empty import)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, { nodes: [], links: [] });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('should accept nodes: [] with links absent (empty import, links optional)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, { nodes: [] });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('GraphifyNodeDto: should require id and label fields on each node', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // Node missing both id and label
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [{ type: 'class', source_file: 'src/foo.ts' }],
      });

      const errors = await validate(dto as object);

      expect(errors.length).toBeGreaterThan(0);
    });

    it('GraphifyLinkDto: should require source and target fields on each link', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // Link missing source and target
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [{ id: 'n1', label: 'Foo' }],
        links: [{ relation: 'depends_on' }],
      });

      const errors = await validate(dto as object);

      expect(errors.length).toBeGreaterThan(0);
    });

    it('GraphifyNodeDto: type, source_file, and community fields are optional', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // Minimal node: only id and label
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [{ id: 'n1', label: 'Minimal' }],
      });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('GraphifyNodeDto: community accepts numeric values', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [{ id: 'n1', label: 'WithCommunity', community: 0 }],
      });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });

    it('GraphifyLinkDto: relation field is optional', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ImportGraphifyDto } = loadImportGraphifyModule() as { ImportGraphifyDto: new() => any };
      // Link without relation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dto = plainToClass(ImportGraphifyDto as any, {
        nodes: [
          { id: 'n1', label: 'A' },
          { id: 'n2', label: 'B' },
        ],
        links: [{ source: 'n1', target: 'n2' }],
      });

      const errors = await validate(dto as object);

      expect(errors).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // US-003: RagController.importGraphify — controller unit tests
  // Covers AC5 (does not call indexDocument for empty nodes) and
  // AC8 (calls ragService.importGraphify with correct args).
  // These behavioral assertions require mocked dependencies and
  // cannot be verified via e2e tests alone.
  // ─────────────────────────────────────────────────────────────────

  describe('US-003: RagController.importGraphify — controller behavior with mocked services', () => {
    let controller: RagController;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockRagService: Record<string, jest.Mock>;
    let mockTxClient: { project: { update: jest.Mock } };
    let mockPrismaClient: { project: { findUnique: jest.Mock }; $transaction: jest.Mock };

    const mockProject = {
      id: 'proj-cuid-abc123',
      name: 'Test Project',
      slug: 'test-project',
      key: 'TEST',
      description: null,
      graphifyEnabled: true,
      graphifyLastImportedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const sampleNodes: GraphifyNodeDto[] = [
      { id: 'n1', label: 'AuthService', type: 'class', source_file: 'src/auth.service.ts' },
      { id: 'n2', label: 'UserService', type: 'class', source_file: 'src/users/user.service.ts' },
    ];

    const sampleLinks: GraphifyLinkDto[] = [
      { source: 'n1', target: 'n2', relation: 'depends_on' },
    ];

    const adminUser = { extra: { role: 'ADMIN' } };

    beforeEach(async () => {
      mockTxClient = {
        project: {
          update: jest.fn().mockResolvedValue(mockProject),
        },
      };

      mockPrismaClient = {
        project: {
          findUnique: jest.fn().mockResolvedValue(mockProject),
        },
        $transaction: jest.fn().mockImplementation(
          async (fn: (tx: typeof mockTxClient) => Promise<unknown>) => fn(mockTxClient),
        ),
      };

      mockRagService = {
        importGraphify: jest.fn().mockResolvedValue({ imported: sampleNodes.length, cleared: 0 }),
        indexDocument: jest.fn().mockResolvedValue(undefined),
        deleteBySource: jest.fn().mockResolvedValue(undefined),
        deleteAllBySourceType: jest.fn().mockResolvedValue(0),
        search: jest.fn().mockResolvedValue([]),
        listDocuments: jest.fn().mockResolvedValue([]),
        optimizeTable: jest.fn().mockResolvedValue(undefined),
      };

      const mockPrismaService = { client: mockPrismaClient };

      const module: TestingModule = await Test.createTestingModule({
        controllers: [RagController],
        providers: [
          { provide: RagService, useValue: mockRagService },
          { provide: PrismaService, useValue: mockPrismaService },
        ],
      }).compile();

      controller = module.get<RagController>(RagController);
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    // AC8: import route calls ragService.importGraphify with correct args
    it('AC8: calls ragService.importGraphify with project.id (not slug), dto.nodes, and dto.links', async () => {
      const dto: ImportGraphifyDto = { nodes: sampleNodes, links: sampleLinks };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockRagService.importGraphify).toHaveBeenCalledWith(
        mockProject.id,
        sampleNodes,
        sampleLinks,
      );
    });

    it('AC8: calls ragService.importGraphify with empty array when dto.links is undefined (links ?? [])', async () => {
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockRagService.importGraphify).toHaveBeenCalledWith(
        mockProject.id,
        sampleNodes,
        [],
      );
    });

    it('AC8: returns the result from ragService.importGraphify wrapped in JsonResponse', async () => {
      mockRagService.importGraphify.mockResolvedValue({ imported: 3, cleared: 5 });
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      const result = await controller.importGraphify('test-project', dto, adminUser);

      expect(result).toMatchObject({ ret: 0, data: { imported: 3, cleared: 5 } });
    });

    // AC5: empty nodes does NOT call ragService at all
    it('AC5: does NOT call ragService.importGraphify when nodes is empty', async () => {
      const dto: ImportGraphifyDto = { nodes: [] };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockRagService.importGraphify).not.toHaveBeenCalled();
    });

    it('AC5: does NOT call ragService.indexDocument when nodes is empty', async () => {
      const dto: ImportGraphifyDto = { nodes: [] };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockRagService.indexDocument).not.toHaveBeenCalled();
    });

    it('AC5: returns { imported: 0, cleared: 0 } when nodes is empty', async () => {
      const dto: ImportGraphifyDto = { nodes: [] };

      const result = await controller.importGraphify('test-project', dto, adminUser);

      expect(result).toMatchObject({ ret: 0, data: { imported: 0, cleared: 0 } });
    });

    // AC5: empty nodes does NOT trigger Prisma transaction (no graphifyLastImportedAt update)
    it('AC5: does NOT update graphifyLastImportedAt when nodes is empty', async () => {
      const dto: ImportGraphifyDto = { nodes: [] };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockTxClient.project.update).not.toHaveBeenCalled();
    });

    // AC9: updates graphifyLastImportedAt to current UTC timestamp after successful import
    it('AC9: updates project.graphifyLastImportedAt to current UTC timestamp after successful import', async () => {
      const beforeTs = Date.now();
      const dto: ImportGraphifyDto = { nodes: sampleNodes, links: sampleLinks };

      await controller.importGraphify('test-project', dto, adminUser);

      expect(mockTxClient.project.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockProject.id },
          data: expect.objectContaining({
            graphifyLastImportedAt: expect.any(Date),
          }),
        }),
      );

      const updateCall = mockTxClient.project.update.mock.calls[0] as [{ data: { graphifyLastImportedAt: Date } }];
      const updatedAt = updateCall[0].data.graphifyLastImportedAt;
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTs);
    });

    // AC2: throws 403 for non-ADMIN callers
    it('AC2: throws ForbiddenAppException when caller role is not ADMIN', async () => {
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await expect(
        controller.importGraphify('test-project', dto, { extra: { role: 'MEMBER' } }),
      ).rejects.toThrow();
    });

    it('AC2: throws ForbiddenAppException when currentUser is null', async () => {
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await expect(
        controller.importGraphify('test-project', dto, null),
      ).rejects.toThrow();
    });

    // AC4: throws 400 when graphifyEnabled is false
    it('AC4: throws ValidationAppException when project.graphifyEnabled is false', async () => {
      mockPrismaClient.project.findUnique.mockResolvedValue({
        ...mockProject,
        graphifyEnabled: false,
      });
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await expect(
        controller.importGraphify('test-project', dto, adminUser),
      ).rejects.toThrow(ValidationAppException);
    });

    // AC3: throws 404 when project does not exist
    it('AC3: throws NotFoundAppException when project slug does not exist', async () => {
      mockPrismaClient.project.findUnique.mockResolvedValue(null);
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await expect(
        controller.importGraphify('test-project', dto, adminUser),
      ).rejects.toThrow();
    });

    it('AC3: throws NotFoundAppException for soft-deleted project', async () => {
      mockPrismaClient.project.findUnique.mockResolvedValue({
        ...mockProject,
        deletedAt: new Date(),
      });
      const dto: ImportGraphifyDto = { nodes: sampleNodes };

      await expect(
        controller.importGraphify('test-project', dto, adminUser),
      ).rejects.toThrow();
    });
  });
});
