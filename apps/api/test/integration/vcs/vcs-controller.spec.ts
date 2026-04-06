/**
 * VcsController REST Endpoints Tests (VCS-P1-003-C)
 *
 * Tests for VCS connection management endpoints:
 * - POST /projects/:slug/vcs (create) → 201
 * - POST /projects/:slug/vcs (conflict) → 409
 * - POST /projects/:slug/vcs (not found) → 404
 * - GET /projects/:slug/vcs (found) → 200
 * - GET /projects/:slug/vcs (not found) → 404
 * - PATCH /projects/:slug/vcs → 200
 * - DELETE /projects/:slug/vcs → 204
 * - DELETE /projects/:slug/vcs (not found) → 404
 * - POST /projects/:slug/vcs/test → 200
 *
 * All endpoints delegate to VcsConnectionService and return proper HTTP status codes
 * with response DTOs. Tests use mocked services for hermetic unit testing.
 *
 * Run: npx jest test/integration/vcs/vcs-controller.spec.ts --forceExit
 */

import { Test, TestingModule } from '@nestjs/testing';
import { VcsController } from '../../../src/vcs/vcs.controller';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { VcsSyncService } from '../../../src/vcs/vcs-sync.service';
import { VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import { ProjectsService } from '../../../src/projects/projects.service';
import { ConfigService } from '@nestjs/config';
import { CreateVcsConnectionDto, VcsProviderType } from '../../../src/vcs/dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from '../../../src/vcs/dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from '../../../src/vcs/dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from '../../../src/vcs/dto/test-connection-result.dto';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';

describe('VcsController REST Endpoints (VCS-P1-003-C)', () => {
  let controller: VcsController;
  let vcsService: jest.Mocked<VcsConnectionService>;
  let projectsService: jest.Mocked<ProjectsService>;
  let configService: jest.Mocked<ConfigService>;
  let module: TestingModule;

  const mockProject = { id: 'proj-123', slug: 'test-project', name: 'Test Project' };
  const projectId = mockProject.id;
  const projectSlug = mockProject.slug;
  const encryptionKey = 'test-encryption-key-32-chars-long';

  const mockVcsConnection: VcsConnectionResponseDto = {
    id: 'vcs-conn-123',
    projectId,
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    syncMode: 'polling',
    allowedAuthors: '[]',
    pollingIntervalMs: 3600000,
    webhookSecret: undefined,
    lastSyncedAt: undefined,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    // Create mock services
    const mockVcsServiceInstance = {
      create: jest.fn(),
      findByProject: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      testConnection: jest.fn(),
      getFullByProject: jest.fn(),
    };

    const mockProjectsServiceInstance = {
      findBySlug: jest.fn().mockResolvedValue(mockProject),
    };

    const mockConfigServiceInstance = {
      get: jest.fn((key: string) => {
        if (key === 'vcs.encryptionKey') return encryptionKey;
        return undefined;
      }),
    };

    module = await Test.createTestingModule({
      controllers: [VcsController],
      providers: [
        { provide: VcsConnectionService, useValue: mockVcsServiceInstance },
        { provide: VcsSyncService, useValue: {} },
        { provide: VcsWebhookService, useValue: {} },
        { provide: ProjectsService, useValue: mockProjectsServiceInstance },
        { provide: ConfigService, useValue: mockConfigServiceInstance },
      ],
    }).compile();

    controller = module.get<VcsController>(VcsController);
    vcsService = module.get(VcsConnectionService) as jest.Mocked<VcsConnectionService>;
    projectsService = module.get(ProjectsService) as jest.Mocked<ProjectsService>;
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
  });

  afterEach(async () => {
    await module.close();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. POST /projects/:slug/vcs - CREATE CONNECTION
  // ─────────────────────────────────────────────────────────────────

  describe('POST /projects/:slug/vcs (createConnection)', () => {
    it('AC1: returns 201 Created with VcsConnectionResponseDto when given valid CreateVcsConnectionDto', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_test_token_123456',
        repoUrl: 'https://github.com/owner/repo',
        syncMode: 'polling',
      };

      vcsService.create.mockResolvedValue(mockVcsConnection);

      const result = await controller.createConnection(projectSlug, createDto);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.create).toHaveBeenCalledWith(projectId, encryptionKey, createDto);
      expect(result).toEqual(mockVcsConnection);
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('projectId', projectId);
      expect(result).toHaveProperty('provider', 'github');
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('AC2: propagates 409 ConflictException when project already has a connection', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_test_token',
        repoUrl: 'https://github.com/owner/repo',
      };

      vcsService.create.mockRejectedValue(new ValidationAppException('Already has connection', 'vcs_conflict'));

      await expect(controller.createConnection(projectSlug, createDto)).rejects.toThrow(ValidationAppException);
    });

    it('AC3: propagates 404 NotFoundException when project slug is not found', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_test_token',
        repoUrl: 'https://github.com/owner/repo',
      };

      projectsService.findBySlug.mockRejectedValue(new NotFoundAppException('Project not found', 'project_not_found'));

      await expect(controller.createConnection(projectSlug, createDto)).rejects.toThrow(NotFoundAppException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. GET /projects/:slug/vcs - READ CONNECTION
  // ─────────────────────────────────────────────────────────────────

  describe('GET /projects/:slug/vcs (getConnection)', () => {
    it('AC4: returns 200 with VcsConnectionResponseDto when connection exists', async () => {
      vcsService.findByProject.mockResolvedValue(mockVcsConnection);

      const result = await controller.getConnection(projectSlug);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.findByProject).toHaveBeenCalledWith(projectId);
      expect(result).toEqual(mockVcsConnection);
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('AC5: returns 404 when no connection exists for the project', async () => {
      vcsService.findByProject.mockRejectedValue(new NotFoundAppException('No VCS connection', 'vcs_not_found'));

      await expect(controller.getConnection(projectSlug)).rejects.toThrow(NotFoundAppException);
      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. PATCH /projects/:slug/vcs - UPDATE CONNECTION
  // ─────────────────────────────────────────────────────────────────

  describe('PATCH /projects/:slug/vcs (updateConnection)', () => {
    it('AC6: returns 200 with updated VcsConnectionResponseDto when updating syncMode', async () => {
      const updateDto: UpdateVcsConnectionDto = { syncMode: 'webhook' };
      const updatedConnection = { ...mockVcsConnection, syncMode: 'webhook' };

      vcsService.update.mockResolvedValue(updatedConnection);

      const result = await controller.updateConnection(projectSlug, updateDto);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.update).toHaveBeenCalledWith(projectId, encryptionKey, updateDto);
      expect(result).toEqual(updatedConnection);
      expect(result.syncMode).toBe('webhook');
      expect(result).not.toHaveProperty('token');
    });

    it('returns 200 when updating token', async () => {
      const updateDto: UpdateVcsConnectionDto = { token: 'ghp_new_token' };

      vcsService.update.mockResolvedValue(mockVcsConnection);

      const result = await controller.updateConnection(projectSlug, updateDto);

      expect(vcsService.update).toHaveBeenCalledWith(projectId, encryptionKey, updateDto);
      expect(result).toBeTruthy();
      expect(result).not.toHaveProperty('token');
    });

    it('returns 200 when updating webhookSecret', async () => {
      const updateDto: UpdateVcsConnectionDto = { webhookSecret: 'new-secret' };
      const updatedConnection = { ...mockVcsConnection, webhookSecret: 'new-secret' };

      vcsService.update.mockResolvedValue(updatedConnection);

      const result = await controller.updateConnection(projectSlug, updateDto);

      expect(result.webhookSecret).toBe('new-secret');
    });

    it('returns 404 when no connection exists', async () => {
      const updateDto: UpdateVcsConnectionDto = { syncMode: 'webhook' };

      vcsService.update.mockRejectedValue(new NotFoundAppException('No connection', 'vcs_not_found'));

      await expect(controller.updateConnection(projectSlug, updateDto)).rejects.toThrow(NotFoundAppException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. DELETE /projects/:slug/vcs - DELETE CONNECTION
  // ─────────────────────────────────────────────────────────────────

  describe('DELETE /projects/:slug/vcs (deleteConnection)', () => {
    it('AC7: returns 204 No Content when deletion succeeds', async () => {
      vcsService.delete.mockResolvedValue(undefined);

      const result = await controller.deleteConnection(projectSlug);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.delete).toHaveBeenCalledWith(projectId);
      expect(result).toBeUndefined();
    });

    it('AC8: returns 404 when no connection exists', async () => {
      vcsService.delete.mockRejectedValue(new NotFoundAppException('No connection', 'vcs_not_found'));

      await expect(controller.deleteConnection(projectSlug)).rejects.toThrow(NotFoundAppException);
      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. POST /projects/:slug/vcs/test - TEST CONNECTION
  // ─────────────────────────────────────────────────────────────────

  describe('POST /projects/:slug/vcs/test (testConnection)', () => {
    it('AC9: returns 200 with TestConnectionResultDto when testing connection', async () => {
      const testResult: TestConnectionResultDto = {
        success: true,
        latencyMs: 125,
      };

      vcsService.testConnection.mockResolvedValue(testResult);

      const result = await controller.testConnection(projectSlug);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.testConnection).toHaveBeenCalledWith(projectId, encryptionKey);
      expect(result).toEqual(testResult);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('latencyMs');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('returns 200 with success=true when connection test succeeds', async () => {
      const testResult: TestConnectionResultDto = {
        success: true,
        latencyMs: 156,
      };

      vcsService.testConnection.mockResolvedValue(testResult);

      const result = await controller.testConnection(projectSlug);

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('returns 200 with success=false and error when connection test fails', async () => {
      const testResult: TestConnectionResultDto = {
        success: false,
        latencyMs: 89,
        error: 'Invalid token',
      };

      vcsService.testConnection.mockResolvedValue(testResult);

      const result = await controller.testConnection(projectSlug);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token');
    });

    it('throws 404 when no connection exists', async () => {
      vcsService.testConnection.mockRejectedValue(new NotFoundAppException('No connection', 'vcs_not_found'));

      await expect(controller.testConnection(projectSlug)).rejects.toThrow(NotFoundAppException);
      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. RESPONSE DTO VALIDATION
  // ─────────────────────────────────────────────────────────────────

  describe('Response DTO Validation', () => {
    it('VcsConnectionResponseDto never includes token field', async () => {
      vcsService.findByProject.mockResolvedValue(mockVcsConnection);

      const result = await controller.getConnection(projectSlug);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('repoOwner');
      expect(result).toHaveProperty('repoName');
      expect(result).toHaveProperty('syncMode');
      expect(result).toHaveProperty('isActive');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('updatedAt');
      // Token should never be included
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('TestConnectionResultDto includes required fields', async () => {
      const testResult: TestConnectionResultDto = {
        success: true,
        latencyMs: 200,
      };

      vcsService.testConnection.mockResolvedValue(testResult);

      const result = await controller.testConnection(projectSlug);

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('latencyMs');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. ERROR PROPAGATION
  // ─────────────────────────────────────────────────────────────────

  describe('Error Propagation', () => {
    it('propagates NotFoundAppException (404) from service on create', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test',
        repoUrl: 'https://github.com/owner/repo',
      };

      projectsService.findBySlug.mockRejectedValue(new NotFoundAppException('Project not found'));

      await expect(controller.createConnection(projectSlug, createDto)).rejects.toThrow(NotFoundAppException);
    });

    it('propagates ValidationAppException (409) from service on create', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test',
        repoUrl: 'https://github.com/owner/repo',
      };

      vcsService.create.mockRejectedValue(new ValidationAppException('Connection already exists'));

      await expect(controller.createConnection(projectSlug, createDto)).rejects.toThrow(ValidationAppException);
    });

    it('propagates NotFoundAppException (404) from service on get', async () => {
      vcsService.findByProject.mockRejectedValue(new NotFoundAppException('Connection not found'));

      await expect(controller.getConnection(projectSlug)).rejects.toThrow(NotFoundAppException);
    });

    it('propagates NotFoundAppException (404) from service on delete', async () => {
      vcsService.delete.mockRejectedValue(new NotFoundAppException('Connection not found'));

      await expect(controller.deleteConnection(projectSlug)).rejects.toThrow(NotFoundAppException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. SERVICE DELEGATION
  // ─────────────────────────────────────────────────────────────────

  describe('Service Delegation', () => {
    it('resolves project by slug and passes projectId to service', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test',
        repoUrl: 'https://github.com/owner/repo',
      };

      vcsService.create.mockResolvedValue(mockVcsConnection);

      await controller.createConnection(projectSlug, createDto);

      expect(projectsService.findBySlug).toHaveBeenCalledWith(projectSlug);
      expect(vcsService.create).toHaveBeenCalledWith(projectId, expect.any(String), createDto);
    });

    it('retrieves encryption key from config for operations that need it', async () => {
      vcsService.create.mockResolvedValue(mockVcsConnection);

      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test',
        repoUrl: 'https://github.com/owner/repo',
      };

      await controller.createConnection(projectSlug, createDto);

      // Verify encryption key was retrieved from config for create operation
      expect(configService.get).toHaveBeenCalledWith('vcs.encryptionKey');
    });

    it('passes correct DTO to service on create', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_abc123',
        repoUrl: 'https://github.com/test/repo',
        syncMode: 'webhook',
        webhookSecret: 'secret-value',
      };

      vcsService.create.mockResolvedValue(mockVcsConnection);

      await controller.createConnection(projectSlug, createDto);

      expect(vcsService.create).toHaveBeenCalledWith(projectId, encryptionKey, createDto);
    });

    it('passes correct DTO to service on update', async () => {
      const updateDto: UpdateVcsConnectionDto = {
        token: 'new-token',
        syncMode: 'webhook',
      };

      vcsService.update.mockResolvedValue(mockVcsConnection);

      await controller.updateConnection(projectSlug, updateDto);

      expect(vcsService.update).toHaveBeenCalledWith(projectId, encryptionKey, updateDto);
    });
  });
});
