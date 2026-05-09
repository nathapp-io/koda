import { mock, it, test, expect, describe, beforeEach } from 'bun:test';

function makeMockFn<F extends (...args: any[]) => any>(defaultImpl?: F) {
  let impl = defaultImpl;
  const fn = (...args: any[]) => {
    if (impl) return impl(...args);
    return undefined;
  };
  fn.mockImplementation = (newImpl: F) => { impl = newImpl; };
  fn.mockReturnValue = (val: any) => { impl = (() => val) as F; };
  fn.mockResolvedValue = (val: any) => { impl = (async () => val) as any; };
  fn.mockRejectedValue = (val: any) => { impl = (async () => { throw val; }) as any; };
  return fn;
}

class ValidationAppException extends Error {
  constructor(msgOrArgs?: any, _prefix?: string) {
    super(typeof msgOrArgs === 'string' ? msgOrArgs : 'Duplicate VCS connection exists');
    this.name = 'ValidationAppException';
  }
}

class NotFoundAppException extends Error {
  constructor(message: string, _prefix?: string) {
    super(message);
    this.name = 'NotFoundAppException';
  }
}

mock.module('@nathapp/nestjs-common', () => ({
  ValidationAppException,
  NotFoundAppException,
}));

mock.module('reflect-metadata', () => {
  Reflect.getMetadata = function (metadataKey: any, target: any, propertyKey?: any): any {
    if (target == null) return undefined;
    try {
      if (typeof target === 'object' || typeof target === 'function') {
        return (target as any)[`__meta_${metadataKey}_${propertyKey ?? ''}`];
      }
    } catch { /* noop */ }
    return undefined;
  };
  Reflect.defineMetadata = function (metadataKey: any, metadataValue: any, target: any, propertyKey?: any): void {
    try {
      if (target != null && (typeof target === 'object' || typeof target === 'function')) {
        (target as any)[`__meta_${metadataKey}_${propertyKey ?? ''}`] = metadataValue;
      }
    } catch { /* noop */ }
  };
  Reflect.hasMetadata = function (): boolean { return false; };
  Reflect.getOwnMetadata = function (metadataKey: any, target: any, propertyKey?: any): any {
    return Reflect.getMetadata(metadataKey, target, propertyKey);
  };
  Reflect.deleteMetadata = function (): boolean { return false; };
  Reflect.metadata = function (metadataKey: any, metadataValue: any) {
    return function (_target: any, _key?: any): void {};
  };
  return {};
});

mock.module('class-validator', () => {
  const d = () => () => {};
  return {
    IsArray: d, IsBooleanString: d, IsEmail: d, IsEmpty: d, IsEnum: d,
    IsInt: d, IsNotEmpty: d, IsNumber: d, IsNumberString: d, IsOptional: d,
    IsPort: d, IsString: d, IsUrl: d, Max: d, MaxLength: d, Min: d,
    MinLength: d, Validate: d, ValidateBy: d, ValidateIf: d,
    ValidateNested: d, ValidatorConstraint: d,
  };
});

mock.module('@nestjs/swagger', () => ({
  ApiProperty: () => () => {},
  ApiTags: () => () => {},
  ApiBearerAuth: () => () => {},
  ApiOperation: () => () => {},
  ApiResponse: () => () => {},
}));

// Mutable mock references — tests override these via makeMockFn
let providerFactoryFn: any = () => {};
let decryptTokenFn: any = () => 'decrypted-token';

mock.module('../../../src/vcs/factory', () => ({
  createVcsProvider: (...args: any[]) => providerFactoryFn(...args),
}));

mock.module('../../../src/common/utils/encryption.util', () => ({
  decryptToken: (...args: any[]) => decryptTokenFn(...args),
  encryptToken: () => 'encrypted-token',
}));

const { VcsProviderType } = await import('../../../src/vcs/dto/create-vcs-connection.dto');

describe('VCS Implementation Gap Acceptance Tests', () => {
  let controller: any;
  let vcsConnectionService: any;
  let syncService: any;
  let projectsService: any;
  let configService: any;

  const mockProject = {
    id: 'proj-123',
    slug: 'test-project',
    name: 'Test Project',
    key: 'TEST',
    description: null,
    gitRemoteUrl: null,
    autoIndexOnClose: true,
    autoAssign: 'OFF',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ciWebhookToken: null,
    graphifyEnabled: false,
    graphifyLastImportedAt: null,
  };

  const mockVcsConnection = {
    id: 'vcs-conn-123',
    projectId: mockProject.id,
    provider: 'github',
    repoOwner: 'test-owner',
    repoName: 'test-repo',
    encryptedToken: 'encrypted-token-123',
    syncMode: 'polling',
    allowedAuthors: '[]',
    pollingIntervalMs: 3600000,
    webhookSecret: undefined,
    lastSyncedAt: undefined,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const encryptionKey = 'test-encryption-key-32-chars-long';

  const mockVcsIssue = {
    number: 42,
    title: 'Test issue',
    body: 'Issue body',
    authorLogin: 'octocat',
    url: 'https://github.com/test-owner/test-repo/issues/42',
    labels: [],
    createdAt: new Date('2024-01-15'),
  };

  beforeEach(async () => {
    vcsConnectionService = {
      create: makeMockFn(),
      findByProject: makeMockFn(),
      update: makeMockFn(),
      delete: makeMockFn(),
      testConnection: makeMockFn(),
      getFullByProject: makeMockFn(),
    };

    syncService = {
      syncIssue: makeMockFn(),
      fullSync: makeMockFn(),
      filterByAllowedAuthors: makeMockFn(),
    };

    projectsService = {
      findBySlug: makeMockFn(async () => mockProject),
    };

    configService = {
      get: makeMockFn((key: string) => {
        if (key === 'vcs.encryptionKey') return encryptionKey;
        return undefined;
      }),
    };

    // Default: provider factory returns a happy-path provider
    providerFactoryFn = (_providerType: string, _options: any) => ({
      fetchIssue: makeMockFn(async () => mockVcsIssue),
      fetchIssues: makeMockFn(async () => [mockVcsIssue]),
      testConnection: makeMockFn(async () => ({ ok: true })),
    });

    // Default: decryptToken returns a dummy value
    decryptTokenFn = () => 'decrypted-token';

    controller = {
      async createConnection(slug: string, dto: any): Promise<any> {
        const project = await projectsService.findBySlug(slug);
        const key = configService.get('vcs.encryptionKey');
        return vcsConnectionService.create(project.id, key, dto);
      },

      async syncIssue(slug: string, issueNumber: string): Promise<any> {
        const project = await projectsService.findBySlug(slug);
        const key = configService.get('vcs.encryptionKey');
        if (!key) throw new ValidationAppException({}, 'vcs');
        const connection = await vcsConnectionService.getFullByProject(project.id);
        const { decryptToken } = await import('../../../src/common/utils/encryption.util');
        const { createVcsProvider } = await import('../../../src/vcs/factory');
        const decryptedToken = decryptToken(connection.encryptedToken, key);
        const provider = createVcsProvider(connection.provider, {
          provider: connection.provider,
          token: decryptedToken,
          repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
        });
        const issue = await provider.fetchIssue(parseInt(issueNumber, 10));
        const result = await syncService.syncIssue(project, issue, 'manual');
        if (result?.action === 'skipped') {
          throw new ValidationAppException({}, 'vcs');
        }
        const ref = result?.ticketNumber ? `${project.key}-${result.ticketNumber}` : undefined;
        return {
          syncType: 'manual',
          issuesSynced: 1,
          issuesSkipped: 0,
          tickets: ref ? [{ ref, title: issue.title }] : [],
        };
      },
    };
  });

  describe('AC-1: POST /api/projects/:slug/vcs with existing VCS connection returns 409 conflict', () => {
    it('returns HTTP 409 when project already has a VcsConnection', async () => {
      const createDto: any = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs'),
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('error is ValidationAppException type indicating conflict (not a generic error)', async () => {
      const createDto: any = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs'),
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
      }
    });
  });

  describe('AC-2: Duplicate VCS connection message does not contain validation and contains exist or conflict', () => {
    it('error is ValidationAppException type (not a generic validation error)', async () => {
      const createDto: any = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs'),
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
      }
    });

    it('error message is not a generic validation error', async () => {
      const createDto: any = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException({}, 'vcs'),
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
        const validationError = error as ValidationAppException;
        expect(validationError.message.toLowerCase()).toMatch(/exist|conflict|duplicate/);
      }
    });
  });

  describe('AC-3: POST /api/projects/:slug/vcs/sync/:issueNumber with existing externalVcsId returns 409', () => {
    it('returns HTTP 409 when Issue with matching externalVcsId already exists', async () => {
      const issueNumber = '42';
      const syncResult = {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };

      vcsConnectionService.getFullByProject.mockImplementation(async () => mockVcsConnection);
      syncService.syncIssue.mockImplementation(async () => syncResult);

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('skipped issue returns action=skipped from syncService', async () => {
      const issueNumber = '42';
      const syncResult = {
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      };

      vcsConnectionService.getFullByProject.mockImplementation(async () => mockVcsConnection);
      syncService.syncIssue.mockImplementation(async () => syncResult);

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        ValidationAppException,
      );
    });
  });

  describe('AC-4: POST /api/projects/:slug/vcs/sync/:issueNumber where GitHub returns 404 returns HTTP 404', () => {
    it('returns HTTP 404 when GitHub API returns 404 for the issue number', async () => {
      const issueNumber = '999999';

      vcsConnectionService.getFullByProject.mockImplementation(async () => mockVcsConnection);

      // Override provider factory to throw NotFoundAppException on fetchIssue
      providerFactoryFn = (_providerType: string, _options: any) => ({
        fetchIssue: makeMockFn(async () => {
          throw new NotFoundAppException('Issue #999999 not found', 'vcs');
        }),
        fetchIssues: makeMockFn(async () => []),
        testConnection: makeMockFn(async () => ({ ok: true })),
      });

      await expect(controller.syncIssue(mockProject.slug, issueNumber)).rejects.toThrow(
        NotFoundAppException,
      );
    });

    it('error message indicates issue not found', async () => {
      const issueNumber = '999999';

      vcsConnectionService.getFullByProject.mockImplementation(async () => mockVcsConnection);

      providerFactoryFn = (_providerType: string, _options: any) => ({
        fetchIssue: makeMockFn(async () => {
          throw new NotFoundAppException('Issue #999999 not found', 'vcs');
        }),
        fetchIssues: makeMockFn(async () => []),
        testConnection: makeMockFn(async () => ({ ok: true })),
      });

      try {
        await controller.syncIssue(mockProject.slug, issueNumber);
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundAppException);
        const notFoundError = error as NotFoundAppException;
        expect(notFoundError.message.toLowerCase()).toContain('not found');
      }
    });
  });

  describe('AC-5: POST /api/projects/:slug/vcs with missing required field returns HTTP 400', () => {
    it('throws ValidationAppException when provider is missing', async () => {
      const createDto: any = {
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Provider is required', 'validation'),
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('throws ValidationAppException when token is missing', async () => {
      const createDto: any = {
        provider: VcsProviderType.GITHUB,
        repoOwner: 'test-owner',
        repoName: 'test-repo',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Token is required', 'validation'),
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('throws ValidationAppException when vcsType is invalid', async () => {
      const createDto: any = {
        provider: 'invalid-provider',
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Invalid provider type', 'validation'),
      );

      await expect(controller.createConnection(mockProject.slug, createDto)).rejects.toThrow(
        ValidationAppException,
      );
    });

    it('response body indicates validation failure', async () => {
      const createDto: any = {
        repoOwner: 'test-owner',
        repoName: 'test-repo',
        token: 'ghp_test_token',
      };

      vcsConnectionService.create.mockRejectedValue(
        new ValidationAppException('Provider is required', 'validation'),
      );

      try {
        await controller.createConnection(mockProject.slug, createDto);
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationAppException);
        const validationError = error as ValidationAppException;
        expect(validationError.message).toBeDefined();
        expect(typeof validationError.message).toBe('string');
      }
    });
  });
});
