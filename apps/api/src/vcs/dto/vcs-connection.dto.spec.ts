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
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate a valid create DTO with all fields', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
        syncMode: 'webhook',
        webhookSecret: 'webhook-secret-123',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should reject missing provider field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('provider');
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should reject missing token field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        repoUrl: 'https://github.com/owner/repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('token');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should reject missing repoUrl field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'repoUrl')).toBe(true);
    });

    it('should reject invalid provider enum value', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: 'invalid-provider',
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('provider');
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('should reject invalid URL in repoUrl field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoUrl: 'not-a-valid-url',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'repoUrl')).toBe(true);
    });

    it('should reject non-string token field', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 123,
        repoUrl: 'https://github.com/owner/repo',
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('token');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should accept optional syncMode as string', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
        syncMode: 'polling',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should accept optional webhookSecret as string', async () => {
      const dto = plainToInstance(CreateVcsConnectionDto, {
        provider: VcsProviderType.GITHUB,
        token: 'ghp_validtoken123',
        repoUrl: 'https://github.com/owner/repo',
        webhookSecret: 'secret-123',
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

    it('should validate update DTO with webhookSecret field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        webhookSecret: 'new-secret-456',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should validate update DTO with all fields', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        token: 'ghp_newtoken456',
        syncMode: 'polling',
        webhookSecret: 'new-secret-456',
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

    it('should reject non-string syncMode field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        syncMode: true,
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('syncMode');
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should reject non-string webhookSecret field', async () => {
      const dto = plainToInstance(UpdateVcsConnectionDto, {
        webhookSecret: { secret: '123' },
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('webhookSecret');
      expect(errors[0].constraints).toHaveProperty('isString');
    });
  });

  describe('VcsConnectionResponseDto', () => {
    it('should have all required fields from VcsConnection model except token', () => {
      const response = new VcsConnectionResponseDto();
      response.id = '123';
      response.projectId = 'proj-123';
      response.provider = 'github';
      response.repoOwner = 'owner';
      response.repoName = 'repo';
      response.syncMode = 'webhook';
      response.allowedAuthors = '["user1", "user2"]';
      response.pollingIntervalMs = 300000;
      response.lastSyncedAt = new Date();
      response.isActive = true;
      response.createdAt = new Date();
      response.updatedAt = new Date();

      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('projectId');
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

    it('should have optional webhookSecret field', () => {
      const response = new VcsConnectionResponseDto();
      response.webhookSecret = 'secret-123';
      expect(response.webhookSecret).toBe('secret-123');
    });

    it('should have optional lastSyncedAt field', () => {
      const response = new VcsConnectionResponseDto();
      const date = new Date();
      response.lastSyncedAt = date;
      expect(response.lastSyncedAt).toBe(date);
    });
  });

  describe('TestConnectionResultDto', () => {
    it('should have success (boolean) field', () => {
      const result = new TestConnectionResultDto();
      result.success = true;
      expect(result.success).toBe(true);
      expect(typeof result.success).toBe('boolean');
    });

    it('should have latencyMs (number) field', () => {
      const result = new TestConnectionResultDto();
      result.latencyMs = 150;
      expect(result.latencyMs).toBe(150);
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should have optional error (string) field', () => {
      const result = new TestConnectionResultDto();
      result.error = 'Connection timeout';
      expect(result.error).toBe('Connection timeout');
    });

    it('should create instance with success result', () => {
      const result = new TestConnectionResultDto();
      result.success = true;
      result.latencyMs = 100;

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBe(100);
      expect(result.error).toBeUndefined();
    });

    it('should create instance with failure result', () => {
      const result = new TestConnectionResultDto();
      result.success = false;
      result.latencyMs = 5000;
      result.error = 'Authentication failed';

      expect(result.success).toBe(false);
      expect(result.latencyMs).toBe(5000);
      expect(result.error).toBe('Authentication failed');
    });
  });
});
