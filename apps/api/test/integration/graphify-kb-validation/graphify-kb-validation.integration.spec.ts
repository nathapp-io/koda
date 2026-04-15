import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import * as fs from 'fs';
import * as path from 'path';
import { AddDocumentDto } from '../../../src/rag/dto/add-document.dto';
import { ProjectResponseDto } from '../../../src/projects/dto/project-response.dto';
import { UpdateProjectDto } from '../../../src/projects/dto/update-project.dto';
import type { IndexDocumentInput } from '../../../src/rag/rag.service';

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
});
