import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { AstIndexService } from './ast-index.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ConfigService } from '@nestjs/config';
import { IVcsProvider } from '../vcs/vcs-provider';
import { SourceFile } from '../vcs/types';

jest.mock('../common/utils/encryption.util', () => ({
  decryptToken: jest.fn().mockReturnValue('decrypted-token'),
}));

const mockDecryptToken: jest.Mock = jest.requireMock('../common/utils/encryption.util').decryptToken;

jest.mock('../vcs/factory', () => ({
  createVcsProvider: jest.fn(),
}));

import { createVcsProvider } from '../vcs/factory';

function createMockVcsProvider(overrides?: Partial<IVcsProvider>): IVcsProvider {
  return {
    fetchIssues: jest.fn().mockResolvedValue([]),
    fetchIssue: jest.fn().mockResolvedValue(null),
    testConnection: jest.fn().mockResolvedValue({ ok: true }),
    getDefaultBranch: jest.fn().mockResolvedValue('main'),
    createPullRequest: jest.fn(),
    getPullRequestStatus: jest.fn(),
    listPullRequests: jest.fn().mockResolvedValue([]),
    listPrCommits: jest.fn().mockResolvedValue([]),
    fetchCommitFiles: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockPrismaService(vcsConnection: object | null) {
  return {
    client: {
      vcsConnection: {
        findUnique: jest.fn().mockResolvedValue(vcsConnection),
      },
    },
  } as unknown as PrismaService;
}

function createMockAstIndexService() {
  return { indexCommit: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AstIndexService>;
}

function createMockConfigService(encryptionKey?: string) {
  return { get: jest.fn().mockReturnValue(encryptionKey) } as unknown as ConfigService;
}

const defaultConnection = {
  provider: 'github',
  repoOwner: 'test-owner',
  repoName: 'test-repo',
  encryptedToken: 'encrypted-token-data',
};

describe('CodeCommitOutboxHandler', () => {
  let handler: CodeCommitOutboxHandler;
  let mockAstIndex: jest.Mocked<AstIndexService>;
  let mockProvider: IVcsProvider;
  let providerVcsConnection: object | null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDecryptToken.mockReturnValue('decrypted-token');
    providerVcsConnection = null;
  });

  describe('process()', () => {
    it('should skip processing when webhookOnly is true', async () => {
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(null),
        createMockAstIndexService(),
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
        webhookOnly: true,
      });

      // Should return early, no calls to astIndexService
      expect(createVcsProvider).not.toHaveBeenCalled();
    });

    it('should skip processing when changedFiles is empty', async () => {
      mockAstIndex = createMockAstIndexService();
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(null),
        mockAstIndex,
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: [],
        projectId: 'proj-1',
      });

      expect(mockAstIndex.indexCommit).not.toHaveBeenCalled();
    });

    it('should skip processing when changedFiles property is absent', async () => {
      mockAstIndex = createMockAstIndexService();
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(null),
        mockAstIndex,
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        projectId: 'proj-1',
      } as unknown);

      expect(mockAstIndex.indexCommit).not.toHaveBeenCalled();
    });

    it('should handle missing VCS connection gracefully (logs warning, no crash)', async () => {
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(null),
        createMockAstIndexService(),
        createMockConfigService('enc-key'),
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
      });

      // Should return early without calling astIndexService
      expect(createVcsProvider).not.toHaveBeenCalled();
    });

    it('should handle missing encryption key gracefully', async () => {
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(defaultConnection),
        createMockAstIndexService(),
        createMockConfigService(undefined),
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
      });

      expect(createVcsProvider).not.toHaveBeenCalled();
    });

    it('should handle decryptToken failure gracefully', async () => {
      mockDecryptToken.mockImplementation(() => {
        throw new Error('decryption failed');
      });

      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(defaultConnection),
        createMockAstIndexService(),
        createMockConfigService('enc-key'),
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
      });

      expect(createVcsProvider).not.toHaveBeenCalled();
      expect(mockDecryptToken).toHaveBeenCalledWith('encrypted-token-data', 'enc-key');
    });

    it('should re-throw fetchCommitFiles errors', async () => {
      mockProvider = createMockVcsProvider({
        fetchCommitFiles: jest.fn().mockRejectedValue(new Error('API rate limit exceeded')),
      });
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(defaultConnection),
        createMockAstIndexService(),
        createMockConfigService('enc-key'),
      );

      await expect(handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
      })).rejects.toThrow('API rate limit exceeded');
    });

    it('happy path: should fetch files and call AstIndexService.indexCommit', async () => {
      const sourceFiles: SourceFile[] = [
        { path: 'src/a.ts', content: 'export const x = 1;' },
      ];
      mockProvider = createMockVcsProvider({
        fetchCommitFiles: jest.fn().mockResolvedValue(sourceFiles),
      });
      (createVcsProvider as jest.Mock).mockReturnValue(mockProvider);

      mockAstIndex = createMockAstIndexService();
      handler = new CodeCommitOutboxHandler(
        createMockPrismaService(defaultConnection),
        mockAstIndex,
        createMockConfigService('enc-key'),
      );

      await handler.process({
        repoId: 'repo-1',
        commitHash: 'abc123',
        ref: 'refs/heads/main',
        changedFiles: ['src/a.ts'],
        projectId: 'proj-1',
      });

      expect(mockDecryptToken).toHaveBeenCalledWith('encrypted-token-data', 'enc-key');
      expect(createVcsProvider).toHaveBeenCalledWith('github', expect.objectContaining({
        provider: 'github',
        token: 'decrypted-token',
        repoUrl: 'https://github.com/test-owner/test-repo',
      }));
      expect(mockProvider.fetchCommitFiles).toHaveBeenCalledWith('abc123', ['src/a.ts']);
      expect(mockAstIndex.indexCommit).toHaveBeenCalledWith(
        'repo-1',
        'abc123',
        sourceFiles,
        'proj-1',
      );
    });
  });
});
