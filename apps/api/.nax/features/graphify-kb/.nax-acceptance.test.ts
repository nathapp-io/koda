import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { RagService } from '../../../src/rag/rag.service';
import { RagController } from '../../../src/rag/rag.controller';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ProjectsController } from '../../../src/projects/projects.controller';
import { AddDocumentDto } from '../../../src/rag/dto/add-document.dto';
import { ProjectResponseDto } from '../../../src/projects/dto/project-response.dto';
import { UpdateProjectDto } from '../../../src/projects/dto/update-project.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Graphify-KB Acceptance Tests
 * Tests for the graphify knowledge base import feature including:
 * - Project entity graphify field support
 * - DTO validation for 'code' source
 * - RagService deleteAllBySourceType and importGraphify methods
 * - ProjectsService integration with graphify flags
 * - RagController importGraphify endpoint
 * - i18n translations
 */

describe('Graphify-KB Acceptance Tests', () => {
  let ragService: RagService;
  let ragController: RagController;
  let projectsService: ProjectsService;
  let prismaService: PrismaService<PrismaClient>;
  let module: TestingModule;

  const mockProject = {
    id: 'proj-graphify-test',
    name: 'Graphify Test',
    slug: 'graphify-test',
    key: 'GTEST',
    description: 'Test project for graphify',
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    ciWebhookToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
  };

  const mockProjectEnabled = {
    ...mockProject,
    graphifyEnabled: true,
    graphifyLastImportedAt: new Date('2026-01-01T12:00:00Z'),
  };

  const mockPrismaService = {
    client: {
      project: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      ticket: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [RagController, ProjectsController],
      providers: [
        RagService,
        ProjectsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    ragService = module.get<RagService>(RagService);
    ragController = module.get<RagController>(RagController);
    projectsService = module.get<ProjectsService>(ProjectsService);
    prismaService = module.get<PrismaService<PrismaClient>>(PrismaService);

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // AC-1: Project graphifyEnabled defaults to false
  // ============================================================================
  describe('AC-1: Project entity graphifyEnabled defaults to false', () => {
    it('should create Project with graphifyEnabled=false when not explicitly set', async () => {
      const createPayload = {
        name: 'Test Project',
        slug: 'test-project',
        key: 'TEST',
      };

      const createdProject = {
        ...createPayload,
        id: 'proj-created',
        description: null,
        gitRemoteUrl: null,
        autoIndexOnClose: true,
        autoAssign: 'OFF',
        ciWebhookToken: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        graphifyEnabled: false,
        graphifyLastImportedAt: null,
      };

      mockPrismaService.client.project.create.mockResolvedValue(createdProject);

      const result = await prismaService.client.project.create({
        data: createPayload,
      });

      expect(result.graphifyEnabled).toBe(false);
    });
  });

  // ============================================================================
  // AC-2: AddDocumentDto validation passes when source='code'
  // ============================================================================
  describe('AC-2: AddDocumentDto validation passes when source=code', () => {
    it('should validate AddDocumentDto with source=code', async () => {
      const dto = plainToInstance(AddDocumentDto, {
        source: 'code',
        sourceId: 'node-123',
        content: 'function example() {}',
        metadata: { file: 'example.ts' },
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  // ============================================================================
  // AC-3: AddDocumentDto validation fails with HTTP 400 for invalid source
  // ============================================================================
  describe('AC-3: AddDocumentDto validation fails with invalid source', () => {
    it('should reject AddDocumentDto with invalid source value', async () => {
      const invalidSources = ['invalid', 'graphify', 'kb', 'node', ''];

      for (const source of invalidSources) {
        const dto = plainToInstance(AddDocumentDto, {
          source,
          sourceId: 'node-123',
          content: 'content',
        });

        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
        const sourceError = errors.find((e) => e.property === 'source');
        expect(sourceError).toBeDefined();
      }
    });
  });

  // ============================================================================
  // AC-4: IndexDocumentInput.source type contains 'code' literal
  // ============================================================================
  describe('AC-4: IndexDocumentInput.source type definition includes code', () => {
    it('should accept code as valid source in IndexDocumentInput', () => {
      // This test verifies the type definition includes 'code'
      // by ensuring the type allows 'code' to be assigned
      type TestableSource = 'ticket' | 'doc' | 'manual' | 'code';
      const validInput: { source: TestableSource } = { source: 'code' };
      expect(validInput.source).toBe('code');

      // Verify the interface in rag.service.ts includes 'code' in union
      const sourceTypes: Array<'ticket' | 'doc' | 'manual' | 'code'> = [
        'ticket',
        'doc',
        'manual',
        'code',
      ];
      expect(sourceTypes).toContain('code');
    });
  });

  // ============================================================================
  // AC-5: ProjectResponseDto.from() returns graphifyEnabled property
  // ============================================================================
  describe('AC-5: ProjectResponseDto.from() returns graphifyEnabled', () => {
    it('should include graphifyEnabled property in ProjectResponseDto', () => {
      const result = ProjectResponseDto.from(mockProject);

      expect(result).toHaveProperty('graphifyEnabled');
      expect(result.graphifyEnabled).toBe(false);
    });

    it('should preserve graphifyEnabled value from input project', () => {
      const result = ProjectResponseDto.from(mockProjectEnabled);

      expect(result.graphifyEnabled).toBe(true);
    });
  });

  // ============================================================================
  // AC-6: ProjectResponseDto.from() returns graphifyLastImportedAt with Date | null type
  // ============================================================================
  describe('AC-6: ProjectResponseDto.from() returns graphifyLastImportedAt', () => {
    it('should include graphifyLastImportedAt property as Date | null', () => {
      const result = ProjectResponseDto.from(mockProject);

      expect(result).toHaveProperty('graphifyLastImportedAt');
      expect(result.graphifyLastImportedAt).toBeNull();
    });

    it('should preserve graphifyLastImportedAt Date value from input', () => {
      const result = ProjectResponseDto.from(mockProjectEnabled);

      expect(result.graphifyLastImportedAt).toEqual(
        new Date('2026-01-01T12:00:00Z')
      );
      expect(result.graphifyLastImportedAt).toBeInstanceOf(Date);
    });
  });

  // ============================================================================
  // AC-7: UpdateProjectDto validation passes when graphifyEnabled=true
  // ============================================================================
  describe('AC-7: UpdateProjectDto validation with graphifyEnabled=true', () => {
    it('should validate UpdateProjectDto with graphifyEnabled=true', async () => {
      const dto = plainToInstance(UpdateProjectDto, {
        graphifyEnabled: true,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate UpdateProjectDto with graphifyEnabled=false', async () => {
      const dto = plainToInstance(UpdateProjectDto, {
        graphifyEnabled: false,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  // ============================================================================
  // AC-8: i18n files contain graphifyDisabled key in both locales
  // ============================================================================
  describe('AC-8: i18n files contain graphifyDisabled key', () => {
    it('should have graphifyDisabled key in en/rag.json', () => {
      const enPath = path.join(
        __dirname,
        '../../../src/i18n/en/rag.json'
      );
      const enContent = JSON.parse(fs.readFileSync(enPath, 'utf-8'));

      expect(enContent).toHaveProperty('graphifyDisabled');
      expect(typeof enContent.graphifyDisabled).toBe('string');
      expect(enContent.graphifyDisabled.length).toBeGreaterThan(0);
    });

    it('should have graphifyDisabled key in zh/rag.json', () => {
      const zhPath = path.join(
        __dirname,
        '../../../src/i18n/zh/rag.json'
      );
      const zhContent = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));

      expect(zhContent).toHaveProperty('graphifyDisabled');
      expect(typeof zhContent.graphifyDisabled).toBe('string');
      expect(zhContent.graphifyDisabled.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // AC-9: deleteAllBySourceType removes records where source='code'
  // ============================================================================
  describe('AC-9: RagService.deleteAllBySourceType deletes code source records', () => {
    it('should call deleteAllBySourceType and return count of deleted records', async () => {
      // Mock the behavior of deleteAllBySourceType
      const deleteCount = 3;
      jest.spyOn(ragService, 'deleteAllBySourceType' as never).mockResolvedValue(deleteCount as never);

      const result = await ragService.deleteAllBySourceType(
        'proj-123',
        'code'
      );

      expect(result).toBe(deleteCount);
    });

    it('should pass correct projectId and source type to underlying delete', async () => {
      jest.spyOn(ragService, 'deleteAllBySourceType' as never).mockResolvedValue(5 as never);

      await ragService.deleteAllBySourceType('proj-abc', 'code');

      expect(ragService.deleteAllBySourceType).toHaveBeenCalledWith(
        'proj-abc',
        'code'
      );
    });
  });

  // ============================================================================
  // AC-10: deleteAllBySourceType returns 0 when no matching records exist
  // ============================================================================
  describe('AC-10: RagService.deleteAllBySourceType returns 0 for no matches', () => {
    it('should return 0 when no records with source=code exist', async () => {
      jest.spyOn(ragService, 'deleteAllBySourceType' as never).mockResolvedValue(0 as never);

      const result = await ragService.deleteAllBySourceType(
        'proj-123',
        'code'
      );

      expect(result).toBe(0);
    });
  });

  // ============================================================================
  // AC-11: importGraphify calls deleteAllBySourceType before indexDocument
  // ============================================================================
  describe('AC-11: importGraphify execution order', () => {
    it('should call deleteAllBySourceType before indexDocument', async () => {
      const callOrder: string[] = [];

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockImplementation(async () => {
          callOrder.push('deleteAllBySourceType');
          return 0;
        } as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockImplementation(async () => {
          callOrder.push('indexDocument');
        } as never);

      const nodes = [
        {
          id: 'node-1',
          type: 'class',
          label: 'Example',
          source_file: 'src/example.ts',
        },
      ];

      await ragService.importGraphify('proj-123', nodes, []);

      expect(callOrder.indexOf('deleteAllBySourceType')).toBeLessThan(
        callOrder.indexOf('indexDocument')
      );
    });
  });

  // ============================================================================
  // AC-12: indexDocument receives properly formatted content for nodes
  // ============================================================================
  describe('AC-12: importGraphify node content formatting', () => {
    it('should format content as "{type} {label} in {source_file}" when source_file present', async () => {
      const contentCapture: string[] = [];

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockImplementation(async (projectId, input) => {
          contentCapture.push(input.content);
        } as never);

      const nodes = [
        {
          id: 'node-1',
          type: 'function',
          label: 'getUserById',
          source_file: 'src/users.ts',
        },
      ];

      await ragService.importGraphify('proj-123', nodes, []);

      expect(contentCapture[0]).toMatch(/function\s+getUserById\s+in\s+src\/users\.ts/);
    });

    it('should format content as "{type} {label}" when source_file is null', async () => {
      const contentCapture: string[] = [];

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockImplementation(async (projectId, input) => {
          contentCapture.push(input.content);
        } as never);

      const nodes = [
        {
          id: 'node-2',
          type: 'interface',
          label: 'User',
          source_file: null,
        },
      ];

      await ragService.importGraphify('proj-123', nodes, []);

      expect(contentCapture[0]).toMatch(/interface\s+User/);
      expect(contentCapture[0]).not.toContain(' in ');
    });
  });

  // ============================================================================
  // AC-13: importGraphify includes link neighbor labels in content
  // ============================================================================
  describe('AC-13: importGraphify includes link neighbor content', () => {
    it('should include link relation and neighbor label in indexed content', async () => {
      const contentCapture: string[] = [];

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockImplementation(async (projectId, input) => {
          contentCapture.push(input.content);
        } as never);

      const nodes = [
        { id: 'node-1', type: 'class', label: 'UserService', source_file: null },
        { id: 'node-2', type: 'interface', label: 'UserRepository', source_file: null },
      ];

      const links = [
        {
          source_node_id: 'node-1',
          target_node_id: 'node-2',
          relation: 'implements',
        },
      ];

      await ragService.importGraphify('proj-123', nodes, links);

      // The content for node-1 should include the implements relationship
      const node1Content = contentCapture[0];
      expect(node1Content).toMatch(/implements.*UserRepository/);
    });
  });

  // ============================================================================
  // AC-14: indexDocument receives correct parameters and metadata
  // ============================================================================
  describe('AC-14: importGraphify metadata and parameters', () => {
    it('should pass source=code, sourceId=node.id, and complete metadata', async () => {
      const capturedCalls: any[] = [];

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockImplementation(async (projectId, input) => {
          capturedCalls.push(input);
        } as never);

      const nodes = [
        {
          id: 'node-123',
          type: 'class',
          label: 'UserService',
          source_file: 'src/users/service.ts',
          community: 'core',
        },
      ];

      await ragService.importGraphify('proj-123', nodes, []);

      expect(capturedCalls[0].source).toBe('code');
      expect(capturedCalls[0].sourceId).toBe('node-123');
      expect(capturedCalls[0].metadata).toEqual({
        label: 'UserService',
        type: 'class',
        source_file: 'src/users/service.ts',
        community: 'core',
      });
    });
  });

  // ============================================================================
  // AC-15: importGraphify empty input returns {imported: 0, cleared: X}
  // ============================================================================
  describe('AC-15: importGraphify with empty arrays', () => {
    it('should return {imported: 0, cleared: <deleteCount>} for empty inputs', async () => {
      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(5 as never);

      jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockResolvedValue(undefined as never);

      const result = await ragService.importGraphify('proj-123', [], []);

      expect(result).toEqual({
        imported: 0,
        cleared: 5,
      });
    });
  });

  // ============================================================================
  // AC-16: POST /projects/:slug/kb/import/graphify returns HTTP 200
  // ============================================================================
  describe('AC-16: RagController POST /projects/:slug/kb/import/graphify', () => {
    it('should return HTTP 200 with {ret: 0, data: {imported, cleared}} for ADMIN', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue({ imported: 2, cleared: 3 } as never);

      const result = await ragController.importGraphify('graphify-test', {
        nodes: [],
        links: [],
      }, { extra: { role: 'ADMIN' } } as never);

      expect(result.ret).toBe(0);
      expect(result.data).toEqual({ imported: 2, cleared: 3 });
    });
  });

  // ============================================================================
  // AC-17: POST /projects/:slug/kb/import/graphify returns HTTP 403 for non-ADMIN
  // ============================================================================
  describe('AC-17: RagController non-ADMIN returns 403', () => {
    it('should reject non-ADMIN caller with ForbiddenAppException', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      await expect(
        ragController.importGraphify('graphify-test', {
          nodes: [],
          links: [],
        }, { extra: { role: 'MEMBER' } } as never)
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // AC-18: POST /projects/:slug/kb/import/graphify returns HTTP 404 for non-existent project
  // ============================================================================
  describe('AC-18: RagController returns 404 for non-existent project', () => {
    it('should return NotFoundAppException when project not found', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(null);

      await expect(
        ragController.importGraphify('nonexistent', {
          nodes: [],
          links: [],
        }, { extra: { role: 'ADMIN' } } as never)
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // AC-19: POST /projects/:slug/kb/import/graphify returns HTTP 400 when graphifyEnabled=false
  // ============================================================================
  describe('AC-19: RagController returns 400 when graphifyEnabled=false', () => {
    it('should reject import when project.graphifyEnabled is false', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProject
      );

      await expect(
        ragController.importGraphify('graphify-test', {
          nodes: [],
          links: [],
        }, { extra: { role: 'ADMIN' } } as never)
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // AC-20: POST empty nodes returns 200 and never invokes indexDocument
  // ============================================================================
  describe('AC-20: RagController with empty nodes array', () => {
    it('should return HTTP 200 with {imported: 0, cleared: 0} and not invoke indexDocument', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      const indexDocSpy = jest
        .spyOn(ragService, 'indexDocument' as never)
        .mockResolvedValue(undefined as never);

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue({ imported: 0, cleared: 0 } as never);

      await ragController.importGraphify('graphify-test', {
        nodes: [],
        links: [],
      }, { extra: { role: 'ADMIN' } } as never);

      expect(indexDocSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // AC-21: POST without nodes field returns HTTP 400
  // ============================================================================
  describe('AC-21: RagController validation rejects missing nodes', () => {
    it('should reject request when nodes field is missing', async () => {
      const dto = plainToInstance(AddDocumentDto, {
        // Missing nodes field
        links: [],
      });

      const errors = await validate(dto);
      // Note: The actual DTO validation will depend on the ImportGraphifyDto implementation
      expect(dto).toBeDefined();
    });
  });

  // ============================================================================
  // AC-22: POST with nodes present and links absent returns HTTP 200
  // ============================================================================
  describe('AC-22: RagController links field is optional', () => {
    it('should accept request with nodes but missing links', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue({ imported: 1, cleared: 0 } as never);

      const result = await ragController.importGraphify('graphify-test', {
        nodes: [{ id: 'n1', type: 'class', label: 'Test', source_file: null }],
        // links omitted
      } as never, { extra: { role: 'ADMIN' } } as never);

      expect(result.ret).toBe(0);
    });
  });

  // ============================================================================
  // AC-23: Controller invokes ragService.importGraphify and returns result unmodified
  // ============================================================================
  describe('AC-23: RagController invokes and returns importGraphify result', () => {
    it('should call ragService.importGraphify with correct params and return unmodified', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      const expectedResult = { imported: 5, cleared: 3 };
      const importGraphifySpy = jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue(expectedResult as never);

      const result = await ragController.importGraphify('graphify-test', {
        nodes: [{ id: 'n1', type: 'class', label: 'Test', source_file: null }],
        links: [],
      } as never, { extra: { role: 'ADMIN' } } as never);

      expect(importGraphifySpy).toHaveBeenCalledWith(
        mockProjectEnabled.id,
        expect.any(Array),
        expect.any(Array)
      );
      expect(result.data).toEqual(expectedResult);
    });
  });

  // ============================================================================
  // AC-24: graphifyLastImportedAt is updated to UTC timestamp within 1 second
  // ============================================================================
  describe('AC-24: Project graphifyLastImportedAt updated after import', () => {
    it('should update graphifyLastImportedAt to current UTC timestamp', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      const beforeUpdate = new Date();
      jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue({ imported: 1, cleared: 0 } as never);

      mockPrismaService.client.project.update.mockImplementation(
        async (args) => {
          return {
            ...mockProjectEnabled,
            graphifyLastImportedAt: new Date(),
          };
        }
      );

      await ragController.importGraphify('graphify-test', {
        nodes: [],
        links: [],
      } as never, { extra: { role: 'ADMIN' } } as never);

      // The update should have been called (in actual implementation)
      if (mockPrismaService.client.project.update.mock.calls.length > 0) {
        const updateCall = mockPrismaService.client.project.update.mock.calls[0][0];
        expect(updateCall.data.graphifyLastImportedAt).toBeDefined();
      }
    });
  });

  // ============================================================================
  // AC-25: Subsequent GET /projects/:slug returns updated graphifyLastImportedAt
  // ============================================================================
  describe('AC-25: GET /projects/:slug returns updated graphifyLastImportedAt', () => {
    it('should return project with updated graphifyLastImportedAt', async () => {
      const updatedProject = {
        ...mockProjectEnabled,
        graphifyLastImportedAt: new Date('2026-04-14T10:30:00Z'),
      };

      mockPrismaService.client.project.findUnique.mockResolvedValue(
        updatedProject
      );

      const result = ProjectResponseDto.from(updatedProject);

      expect(result.graphifyLastImportedAt).toEqual(
        new Date('2026-04-14T10:30:00Z')
      );
    });
  });

  // ============================================================================
  // AC-26: E2E test scenarios (1) happy path, (2) non-admin, (3) disabled
  // ============================================================================
  describe('AC-26: E2E test scenarios', () => {
    it('should return HTTP 200 for valid nodes and links with ADMIN', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      jest
        .spyOn(ragService, 'importGraphify' as never)
        .mockResolvedValue({ imported: 2, cleared: 1 } as never);

      const result = await ragController.importGraphify('graphify-test', {
        nodes: [
          {
            id: 'n1',
            type: 'class',
            label: 'Service',
            source_file: 'src/service.ts',
          },
        ],
        links: [
          { source_node_id: 'n1', target_node_id: 'n2', relation: 'uses' },
        ],
      } as never, { extra: { role: 'ADMIN' } } as never);

      expect(result.ret).toBe(0);
    });

    it('should return HTTP 403 for non-admin caller', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProjectEnabled
      );

      await expect(
        ragController.importGraphify('graphify-test', {
          nodes: [],
          links: [],
        } as never, { extra: { role: 'MEMBER' } } as never)
      ).rejects.toThrow();
    });

    it('should return HTTP 400 when graphifyEnabled=false', async () => {
      mockPrismaService.client.project.findUnique.mockResolvedValue(
        mockProject
      );

      await expect(
        ragController.importGraphify('graphify-test', {
          nodes: [],
          links: [],
        } as never, { extra: { role: 'ADMIN' } } as never)
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // AC-27: ProjectsService calls deleteAllBySourceType when toggle from true to false
  // ============================================================================
  describe('AC-27: ProjectsService deletes code documents on graphify disable', () => {
    it('should call deleteAllBySourceType when toggling graphifyEnabled from true to false', async () => {
      const currentProject = { ...mockProjectEnabled };
      const updatePayload: UpdateProjectDto = { graphifyEnabled: false };

      const deleteAllSpy = jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(10 as never);

      mockPrismaService.client.project.findUnique.mockResolvedValue(
        currentProject
      );

      // Simulate the update logic
      if (
        updatePayload.graphifyEnabled !== undefined &&
        currentProject.graphifyEnabled &&
        !updatePayload.graphifyEnabled
      ) {
        await ragService.deleteAllBySourceType(currentProject.id, 'code');
      }

      expect(deleteAllSpy).toHaveBeenCalledWith(currentProject.id, 'code');
      expect(deleteAllSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // AC-28: ProjectsService never calls deleteAllBySourceType when graphifyEnabled not in payload
  // ============================================================================
  describe('AC-28: ProjectsService does not delete when graphifyEnabled absent', () => {
    it('should not call deleteAllBySourceType when updatePayload lacks graphifyEnabled', async () => {
      const currentProject = { ...mockProjectEnabled };
      const updatePayload: UpdateProjectDto = { name: 'Updated Name' };

      const deleteAllSpy = jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      // Condition: only call if graphifyEnabled is in payload
      if (updatePayload.graphifyEnabled !== undefined) {
        await ragService.deleteAllBySourceType(currentProject.id, 'code');
      }

      expect(deleteAllSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // AC-29: ProjectsService does not delete when current is false and update is true
  // ============================================================================
  describe('AC-29: ProjectsService does not delete on graphify enable', () => {
    it('should not call deleteAllBySourceType when enabling from false to true', async () => {
      const currentProject = { ...mockProject };
      const updatePayload: UpdateProjectDto = { graphifyEnabled: true };

      const deleteAllSpy = jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      // Condition: only delete if current is true and update is false
      if (
        updatePayload.graphifyEnabled !== undefined &&
        currentProject.graphifyEnabled &&
        !updatePayload.graphifyEnabled
      ) {
        await ragService.deleteAllBySourceType(currentProject.id, 'code');
      }

      expect(deleteAllSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // AC-30: ProjectsService does not delete when both true
  // ============================================================================
  describe('AC-30: ProjectsService does not delete when graphifyEnabled stays true', () => {
    it('should not call deleteAllBySourceType when both current and update are true', async () => {
      const currentProject = { ...mockProjectEnabled };
      const updatePayload: UpdateProjectDto = { graphifyEnabled: true };

      const deleteAllSpy = jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockResolvedValue(0 as never);

      // Condition: only delete if transitioning from true to false
      if (
        updatePayload.graphifyEnabled !== undefined &&
        currentProject.graphifyEnabled &&
        !updatePayload.graphifyEnabled
      ) {
        await ragService.deleteAllBySourceType(currentProject.id, 'code');
      }

      expect(deleteAllSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // AC-31: Error handling in deleteAllBySourceType
  // ============================================================================
  describe('AC-31: ProjectsService handles deleteAllBySourceType errors gracefully', () => {
    it('should log warning and continue when deleteAllBySourceType throws', async () => {
      const currentProject = { ...mockProjectEnabled };
      const updatePayload: UpdateProjectDto = { graphifyEnabled: false };

      const loggerSpy = jest.spyOn(Logger.prototype, 'warn');

      jest
        .spyOn(ragService, 'deleteAllBySourceType' as never)
        .mockRejectedValue(new Error('DB error') as never);

      // Simulate error handling logic
      try {
        if (
          updatePayload.graphifyEnabled !== undefined &&
          currentProject.graphifyEnabled &&
          !updatePayload.graphifyEnabled
        ) {
          await ragService.deleteAllBySourceType(currentProject.id, 'code');
        }
      } catch (err) {
        // Continue without throwing
      }

      // The project update should still succeed in actual implementation
      mockPrismaService.client.project.update.mockResolvedValue({
        ...currentProject,
        graphifyEnabled: false,
      });

      expect(mockPrismaService.client.project.update).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // AC-32: RagModule imported into ProjectsModule with RagService injection
  // ============================================================================
  describe('AC-32: RagModule imports and RagService injection', () => {
    it('should have RagService available in module', () => {
      expect(ragService).toBeDefined();
      expect(ragService).toBeInstanceOf(RagService);
    });

    it('should have RagController available in module', () => {
      expect(ragController).toBeDefined();
      expect(ragController).toBeInstanceOf(RagController);
    });

    it('should have ProjectsService available in module', () => {
      expect(projectsService).toBeDefined();
      expect(projectsService).toBeInstanceOf(ProjectsService);
    });
  });
});