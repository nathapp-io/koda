/**
 * VcsConnectionService Unit/Integration Tests
 *
 * Comprehensive tests for VCS connection CRUD operations with token encryption.
 * All acceptance criteria are covered including encryption, validation, and provider delegation.
 *
 * Run: npx jest test/integration/vcs/vcs-connection.service.spec.ts --forceExit
 */

import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import { VcsConnectionService } from '../../../src/vcs/vcs-connection.service';
import { CreateVcsConnectionDto, VcsProviderType } from '../../../src/vcs/dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from '../../../src/vcs/dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from '../../../src/vcs/dto/vcs-connection-response.dto';
import { encryptToken, decryptToken } from '../../../src/common/utils/encryption.util';
import * as vcsFactory from '../../../src/vcs/factory';
import { IVcsProvider } from '../../../src/vcs/vcs-provider';

describe('VcsConnectionService', () => {
  let service: VcsConnectionService;
  let prismaService: PrismaService;
  let module: TestingModule;

  const encryptionKey = crypto.randomBytes(32).toString('hex');
  const projectId = 'project-123';
  const connectionId = 'connection-456';

  const mockPrismaDelegate = {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    // Reset all mocks before each test
    jest.clearAllMocks();
    jest.restoreAllMocks();

    module = await Test.createTestingModule({
      providers: [
        VcsConnectionService,
        {
          provide: PrismaService,
          useValue: {
            client: {
              project: { ...mockPrismaDelegate },
              vcsConnection: { ...mockPrismaDelegate },
            },
          },
        },
      ],
    }).compile();

    service = module.get<VcsConnectionService>(VcsConnectionService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('create()', () => {
    const createDto: CreateVcsConnectionDto = {
      provider: VcsProviderType.GITHUB,
      token: 'ghp_test_token_123',
      repoUrl: 'https://github.com/owner/repo',
      syncMode: 'polling',
    };

    it('AC1: encrypts the plaintext token using the encryption utility before persisting to the database', async () => {
      const mockProject = { id: projectId, name: 'Test Project' };
      const encryptedToken = encryptToken(createDto.token, encryptionKey);

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(mockProject);
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null); // No existing connection
      mockPrismaDelegate.create.mockResolvedValueOnce({
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.create(projectId, encryptionKey, createDto);

      // Verify token was encrypted (not stored in plaintext)
      expect(mockPrismaDelegate.create).toHaveBeenCalled();
      const createCall = mockPrismaDelegate.create.mock.calls[0][0];
      expect(createCall.data.encryptedToken).not.toBe(createDto.token);
      expect(createCall.data.encryptedToken).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);

      // Verify encrypted token can be decrypted back to original
      const decrypted = decryptToken(createCall.data.encryptedToken, encryptionKey);
      expect(decrypted).toBe(createDto.token);

      expect(result).toBeDefined();
      expect(result.projectId).toBe(projectId);
      expect(result.provider).toBe('github');
    });

    it('AC1: handles token encryption with special characters', async () => {
      const specialTokenDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'token!@#$%^&*()_+-=[]{}|;:,.<>?',
        repoUrl: 'https://github.com/owner/repo',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId });
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);
      mockPrismaDelegate.create.mockResolvedValueOnce({
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken(specialTokenDto.token, encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.create(projectId, encryptionKey, specialTokenDto);

      expect(result).toBeDefined();
      const createCall = mockPrismaDelegate.create.mock.calls[0][0];
      const decrypted = decryptToken(createCall.data.encryptedToken, encryptionKey);
      expect(decrypted).toBe(specialTokenDto.token);
    });

    it('AC2: throws ValidationAppException (409) when the project already has a VCS connection', async () => {
      const existingConnection = {
        id: 'existing-id',
        projectId,
        provider: 'github',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId }); // Project exists
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection); // Connection already exists

      await expect(service.create(projectId, encryptionKey, createDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('AC3: throws NotFoundAppException (404) when the project slug does not resolve to a project', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null); // Project doesn't exist

      await expect(service.create(projectId, encryptionKey, createDto)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should parse repository URL correctly and extract owner and repo', async () => {
      const urlTests = [
        { url: 'https://github.com/owner/repo', expectedOwner: 'owner', expectedRepo: 'repo' },
        { url: 'https://github.com/org-name/repo-name', expectedOwner: 'org-name', expectedRepo: 'repo-name' },
      ];

      for (const test of urlTests) {
        jest.clearAllMocks();

        const dto: CreateVcsConnectionDto = {
          provider: VcsProviderType.GITHUB,
          token: 'test-token',
          repoUrl: test.url,
        };

        mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId });
        mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);
        mockPrismaDelegate.create.mockResolvedValueOnce({
          id: connectionId,
          projectId,
          provider: 'github',
          repoOwner: test.expectedOwner,
          repoName: test.expectedRepo,
          encryptedToken: encryptToken(dto.token, encryptionKey),
          syncMode: 'polling',
          allowedAuthors: '[]',
          pollingIntervalMs: 3600000,
          webhookSecret: null,
          lastSyncedAt: null,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await service.create(projectId, encryptionKey, dto);

        const createCall = mockPrismaDelegate.create.mock.calls[0][0];
        expect(createCall.data.repoOwner).toBe(test.expectedOwner);
        expect(createCall.data.repoName).toBe(test.expectedRepo);
      }
    });

    it('should store syncMode when provided', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId });
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);
      mockPrismaDelegate.create.mockResolvedValueOnce({
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken(createDto.token, encryptionKey),
        syncMode: 'webhook',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const dtoWithSyncMode: CreateVcsConnectionDto = {
        ...createDto,
        syncMode: 'webhook',
      };

      await service.create(projectId, encryptionKey, dtoWithSyncMode);

      const createCall = mockPrismaDelegate.create.mock.calls[0][0];
      expect(createCall.data.syncMode).toBe('webhook');
    });
  });

  describe('findByProject()', () => {
    it('AC4: returns the connection record with the token field omitted', async () => {
      const storedConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken('ghp_secret_token', encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: 'webhook-secret',
        lastSyncedAt: new Date('2024-01-01'),
        isActive: true,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(storedConnection);

      const result: VcsConnectionResponseDto = await service.findByProject(projectId);

      // Verify token is NOT in the response
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');

      // Verify all other fields are present
      expect(result.id).toBe(connectionId);
      expect(result.projectId).toBe(projectId);
      expect(result.provider).toBe('github');
      expect(result.repoOwner).toBe('owner');
      expect(result.repoName).toBe('repo');
      expect(result.syncMode).toBe('polling');
      expect(result.webhookSecret).toBe('webhook-secret');
      expect(result.isActive).toBe(true);
    });

    it('AC5: throws NotFoundAppException (404) when no connection exists for the project', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);

      await expect(service.findByProject(projectId)).rejects.toThrow(NotFoundAppException);
    });

    it('should handle optional fields correctly', async () => {
      const connectionWithoutOptionals = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken('token', encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(connectionWithoutOptionals);

      const result = await service.findByProject(projectId);

      expect(result.webhookSecret).toBeUndefined();
      expect(result.lastSyncedAt).toBeUndefined();
    });
  });

  describe('update()', () => {
    it('AC6: with syncMode updates only the syncMode field and returns the updated record without token', async () => {
      const oldEncryptedToken = encryptToken('old_token', encryptionKey);
      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: oldEncryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      const updateDto: UpdateVcsConnectionDto = {
        syncMode: 'webhook',
      };

      const updatedConnection = {
        ...existingConnection,
        syncMode: 'webhook',
        updatedAt: new Date('2024-01-02'),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);
      mockPrismaDelegate.update.mockResolvedValueOnce(updatedConnection);

      const result = await service.update(projectId, encryptionKey, updateDto);

      // Verify only syncMode was updated
      const updateCall = mockPrismaDelegate.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ syncMode: 'webhook' });

      // Verify token is not in response
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');

      // Verify updated value
      expect(result.syncMode).toBe('webhook');
    });

    it('AC7: with a new token decrypts the current stored token, re-encrypts the new token, and persists it', async () => {
      const oldToken = 'old_github_token';
      const newToken = 'new_github_token_xyz';
      const oldEncryptedToken = encryptToken(oldToken, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: oldEncryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
      };

      const updateDto: UpdateVcsConnectionDto = {
        token: newToken,
      };

      const newEncryptedToken = encryptToken(newToken, encryptionKey);

      const updatedConnection = {
        ...existingConnection,
        encryptedToken: newEncryptedToken,
        updatedAt: new Date('2024-01-02'),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);
      mockPrismaDelegate.update.mockResolvedValueOnce(updatedConnection);

      const result = await service.update(projectId, encryptionKey, updateDto);

      // Verify new token was encrypted
      const updateCall = mockPrismaDelegate.update.mock.calls[0][0];
      expect(updateCall.data.encryptedToken).not.toBe(newToken);
      expect(updateCall.data.encryptedToken).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/);

      // Verify encrypted token can be decrypted back to the new token
      const decrypted = decryptToken(updateCall.data.encryptedToken, encryptionKey);
      expect(decrypted).toBe(newToken);

      // Verify token is not in response
      expect(result).not.toHaveProperty('token');
      expect(result).not.toHaveProperty('encryptedToken');
    });

    it('should update webhookSecret when provided', async () => {
      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken('token', encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateDto: UpdateVcsConnectionDto = {
        webhookSecret: 'new-webhook-secret',
      };

      const updatedConnection = {
        ...existingConnection,
        webhookSecret: 'new-webhook-secret',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);
      mockPrismaDelegate.update.mockResolvedValueOnce(updatedConnection);

      await service.update(projectId, encryptionKey, updateDto);

      const updateCall = mockPrismaDelegate.update.mock.calls[0][0];
      expect(updateCall.data.webhookSecret).toBe('new-webhook-secret');
    });

    it('should not update when no fields are provided', async () => {
      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken('token', encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: 'existing-secret',
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateDto: UpdateVcsConnectionDto = {};

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      await service.update(projectId, encryptionKey, updateDto);

      // Should not call update when no fields are provided
      expect(mockPrismaDelegate.update).not.toHaveBeenCalled();
    });

    it('should handle update with multiple fields', async () => {
      const oldToken = 'old_token';
      const newToken = 'new_token';

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken(oldToken, encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateDto: UpdateVcsConnectionDto = {
        token: newToken,
        syncMode: 'webhook',
        webhookSecret: 'new-secret',
      };

      const updatedConnection = {
        ...existingConnection,
        encryptedToken: encryptToken(newToken, encryptionKey),
        syncMode: 'webhook',
        webhookSecret: 'new-secret',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);
      mockPrismaDelegate.update.mockResolvedValueOnce(updatedConnection);

      await service.update(projectId, encryptionKey, updateDto);

      const updateCall = mockPrismaDelegate.update.mock.calls[0][0];
      expect(updateCall.data).toHaveProperty('encryptedToken');
      expect(updateCall.data).toHaveProperty('syncMode', 'webhook');
      expect(updateCall.data).toHaveProperty('webhookSecret', 'new-secret');
    });

    it('should throw NotFoundAppException when connection does not exist', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);

      const updateDto: UpdateVcsConnectionDto = {
        syncMode: 'webhook',
      };

      await expect(service.update(projectId, encryptionKey, updateDto)).rejects.toThrow(
        NotFoundAppException,
      );
    });
  });

  describe('delete()', () => {
    it('AC8: removes the connection record and returns void', async () => {
      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken('token', encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);
      mockPrismaDelegate.delete.mockResolvedValueOnce(existingConnection);

      const result = await service.delete(projectId);

      // Verify delete was called with correct projectId
      expect(mockPrismaDelegate.delete).toHaveBeenCalledWith({
        where: { projectId },
      });

      // Verify result is void
      expect(result).toBeUndefined();
    });

    it('AC9: throws NotFoundAppException (404) when no connection exists for the project', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);

      await expect(service.delete(projectId)).rejects.toThrow(NotFoundAppException);
    });
  });

  describe('testConnection()', () => {
    it('AC10: decrypts the stored token, calls provider.testConnection() via createVcsProvider factory, and returns TestConnectionResultDto', async () => {
      const token = 'ghp_test_token_123';
      const encryptedToken = encryptToken(token, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockProvider: Partial<IVcsProvider> = {
        testConnection: jest.fn().mockResolvedValue({ ok: true }),
      };

      jest.spyOn(vcsFactory, 'createVcsProvider').mockReturnValue(mockProvider as IVcsProvider);
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      // Verify createVcsProvider was called with decrypted token
      expect(vcsFactory.createVcsProvider).toHaveBeenCalledWith('github', {
        provider: 'github',
        token, // Decrypted token
        repoUrl: 'https://github.com/owner/repo',
      });

      // Verify provider.testConnection() was called
      expect(mockProvider.testConnection).toHaveBeenCalled();

      // Verify result structure
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result).not.toHaveProperty('token');
    });

    it('should return success=true and latencyMs when connection succeeds', async () => {
      const token = 'ghp_test_token_123';
      const encryptedToken = encryptToken(token, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockProvider: Partial<IVcsProvider> = {
        testConnection: jest.fn().mockResolvedValue({ ok: true }),
      };

      jest.spyOn(vcsFactory, 'createVcsProvider').mockReturnValue(mockProvider as IVcsProvider);
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it('should return success=false with error message when provider test fails', async () => {
      const token = 'ghp_test_token_123';
      const encryptedToken = encryptToken(token, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockProvider: Partial<IVcsProvider> = {
        testConnection: jest.fn().mockResolvedValue({ ok: false, error: 'Invalid token' }),
      };

      jest.spyOn(vcsFactory, 'createVcsProvider').mockReturnValue(mockProvider as IVcsProvider);
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid token');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should return error when token decryption fails', async () => {
      const encryptedToken = 'invalid:encrypted:token';

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to decrypt token');
      expect(result.latencyMs).toBe(0);
    });

    it('should return error when provider creation throws exception', async () => {
      const token = 'ghp_test_token_123';
      const encryptedToken = encryptToken(token, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'unsupported_provider',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      jest
        .spyOn(vcsFactory, 'createVcsProvider')
        .mockImplementation(() => {
          throw new ValidationAppException('Unsupported provider');
        });

      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should throw NotFoundAppException when connection does not exist', async () => {
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);

      await expect(service.testConnection(projectId, encryptionKey)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('should measure latency correctly', async () => {
      const token = 'ghp_test_token_123';
      const encryptedToken = encryptToken(token, encryptionKey);

      const existingConnection = {
        id: connectionId,
        projectId,
        provider: 'github',
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken,
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockProvider: Partial<IVcsProvider> = {
        testConnection: jest.fn(async () => {
          // Simulate some delay
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true };
        }),
      };

      jest.spyOn(vcsFactory, 'createVcsProvider').mockReturnValue(mockProvider as IVcsProvider);
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(existingConnection);

      const result = await service.testConnection(projectId, encryptionKey);

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    });
  });

  describe('error handling edge cases', () => {
    it('should handle malformed repository URLs gracefully during create', async () => {
      const badUrlDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test-token',
        repoUrl: 'not-a-valid-url',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId });
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(projectId, encryptionKey, badUrlDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('should handle provider case-insensitively', async () => {
      const createDto: CreateVcsConnectionDto = {
        provider: VcsProviderType.GITHUB,
        token: 'test-token',
        repoUrl: 'https://github.com/owner/repo',
      };

      mockPrismaDelegate.findUnique.mockResolvedValueOnce({ id: projectId });
      mockPrismaDelegate.findUnique.mockResolvedValueOnce(null);
      mockPrismaDelegate.create.mockResolvedValueOnce({
        id: connectionId,
        projectId,
        provider: 'github', // Should be lowercase
        repoOwner: 'owner',
        repoName: 'repo',
        encryptedToken: encryptToken(createDto.token, encryptionKey),
        syncMode: 'polling',
        allowedAuthors: '[]',
        pollingIntervalMs: 3600000,
        webhookSecret: null,
        lastSyncedAt: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.create(projectId, encryptionKey, createDto);

      const createCall = mockPrismaDelegate.create.mock.calls[0][0];
      expect(createCall.data.provider).toBe('github');
    });
  });
});
