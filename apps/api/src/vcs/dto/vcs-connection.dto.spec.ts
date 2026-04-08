import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateVcsConnectionDto, VcsProviderType } from './create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './vcs-connection-response.dto';
import { TestConnectionResultDto } from './test-connection-result.dto';

describe('VCS Connection DTOs', () => {
  describe('CreateVcsConnectionDto', () => {
    it('should validate a valid create DTO with required fields', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_validtoken123',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate a valid create DTO with all fields', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_validtoken123',
        syncMode: 'webhook',
        allowedAuthors: ['user1', 'user2'],
        pollingIntervalMs: 600000,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should reject missing provider field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        token: 'ghp_validtoken123',
        repoOwner: 'owner',
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('provider');
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should reject missing token field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'owner',
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('token');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should reject missing repoOwner field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'repoOwner')).toBe(true);
    });

    it('should reject missing repoName field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoOwner: 'owner',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'repoName')).toBe(true);
    });

    it('should reject invalid provider enum value', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: 'invalid-provider',
        token: 'ghp_validtoken123',
        repoOwner: 'owner',
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('provider');
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should reject non-string repoOwner field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoOwner: 123,
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'repoOwner')).toBe(true);
    });

    it('should reject non-string token field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 123,
        repoOwner: 'owner',
        repoName: 'repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('token');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should accept optional syncMode as string', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_validtoken123',
        syncMode: 'polling',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should accept optional allowedAuthors and pollingIntervalMs', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'owner',
        repoName: 'repo',
        token: 'ghp_validtoken123',
        allowedAuthors: ['user1', 'user2'],
        pollingIntervalMs: 120000,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('UpdateVcsConnectionDto', () => {
    it('should validate an empty update DTO', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {});
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate update DTO with token field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        token: 'ghp_newtoken456',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate update DTO with syncMode field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        syncMode: 'webhook',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate update DTO with allowedAuthors field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        allowedAuthors: ['user1', 'user2'],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate update DTO with all fields', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        token: 'ghp_newtoken456',
        syncMode: 'polling',
        allowedAuthors: ['user1'],
        pollingIntervalMs: 120000,
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should reject non-string token field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        token: 123,
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('token');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should reject invalid syncMode field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        syncMode: 'manual',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('syncMode');
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should reject non-array allowedAuthors field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        allowedAuthors: 'user1,user2',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('allowedAuthors');
      expect(errors[0].constraints).toHaveProperty('isArray');
    });
  });

  describe('VcsConnectionResponseDto', () => {
    it('should have all required fields from VcsConnection model except token', () => {
      const response = new VcsConnectionResponseDto();
      response.id = '123';
      response.provider = 'github';
      response.repoOwner = 'owner';
      response.repoName = 'repo';
      response.syncMode = 'webhook';
      response.allowedAuthors = ['user1', 'user2'];
      response.pollingIntervalMs = 300000;
      response.lastSyncedAt = new Date().toISOString();
      response.isActive = true;
      response.createdAt = new Date().toISOString();
      response.updatedAt = new Date().toISOString();

      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('provider');
      expect(response).toHaveProperty('repoOwner');
      expect(response).toHaveProperty('repoName');
      expect(response).toHaveProperty('syncMode');
      expect(response).toHaveProperty('allowedAuthors');
      expect(response).toHaveProperty('pollingIntervalMs');
      expect(response).toHaveProperty('isActive');
      expect(response).toHaveProperty('createdAt');
      expect(response).toHaveProperty('updatedAt');
    });

    it('should not expose token field', () => {
      const response = new VcsConnectionResponseDto();
      expect(response).not.toHaveProperty('encryptedToken');
      expect(response).not.toHaveProperty('token');
    });

    it('should have optional lastSyncedAt field', () => {
      const response = new VcsConnectionResponseDto();
      const date = new Date().toISOString();
      response.lastSyncedAt = date;
      expect(response.lastSyncedAt).toBe(date);
    });
  });

  describe('TestConnectionResultDto', () => {
    it('should have ok (boolean) field', () => {
      const result = new TestConnectionResultDto();
      result.ok = true;
      expect(result.ok).toBe(true);
      expect(typeof result.ok).toBe('boolean');
    });

    it('should have optional error (string) field', () => {
      const result = new TestConnectionResultDto();
      result.error = 'Connection timeout';
      expect(result.error).toBe('Connection timeout');
    });

    it('should create instance with success result', () => {
      const result = new TestConnectionResultDto();
      result.ok = true;

      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should create instance with failure result', () => {
      const result = new TestConnectionResultDto();
      result.ok = false;
      result.error = 'Authentication failed';

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Authentication failed');
    });
  });
});
