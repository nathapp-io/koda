import type { Mock } from 'vitest';
vi.mock('../vcs/factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../common/utils/encryption.util', () => ({ decryptToken: vi.fn().mockReturnValue('plain') }));

import { createVcsProvider } from '../vcs/factory';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import type { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import type { AstIndexService } from './ast-index.service';
import type { IVcsConfig } from '../config/vcs.config';

describe('CodeCommitOutboxHandler removed files (VCS LOW)', () => {
  let ast: { indexCommit: Mock; removeFiles: Mock };
  let fetchCommitFiles: Mock;
  let handler: CodeCommitOutboxHandler;

  beforeEach(() => {
    ast = { indexCommit: vi.fn(), removeFiles: vi.fn() };
    fetchCommitFiles = vi.fn().mockResolvedValue([{ path: 'src/new.ts', content: 'x' }]);
    (createVcsProvider as Mock).mockReturnValue({ fetchCommitFiles });
    const repo = {
      findVcsConnectionByProjectId: vi.fn().mockResolvedValue({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc' }),
    };
    handler = new CodeCommitOutboxHandler(
      repo as unknown as PrismaCodeIntelRepository,
      ast as unknown as AstIndexService,
      { encryptionKey: 'ab'.repeat(32), githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4', defaultPollingIntervalMs: 1 } as IVcsConfig,
    );
  });

  it('drops symbols of removed files and fetches only the rest', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c1', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/new.ts', 'src/gone.ts'], removedFiles: ['src/gone.ts'],
    });

    expect(ast.removeFiles).toHaveBeenCalledWith('p1', 'acme/widgets', ['src/gone.ts']);
    expect(fetchCommitFiles).toHaveBeenCalledWith('acme/widgets', 'c1', ['src/new.ts']);
    expect(ast.indexCommit).toHaveBeenCalledWith('acme/widgets', 'c1', [{ path: 'src/new.ts', content: 'x' }], 'p1');
  });

  it('only removes when every changed file was deleted', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c2', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/gone.ts'], removedFiles: ['src/gone.ts'],
    });

    expect(ast.removeFiles).toHaveBeenCalledTimes(1);
    expect(fetchCommitFiles).not.toHaveBeenCalled();
  });

  it('indexes a legacy event recorded without removedFiles', async () => {
    await handler.process({
      repoId: 'acme/widgets', commitHash: 'c3', ref: 'refs/heads/main', projectId: 'p1',
      changedFiles: ['src/new.ts'],
    });

    expect(ast.removeFiles).not.toHaveBeenCalled();
    expect(fetchCommitFiles).toHaveBeenCalledWith('acme/widgets', 'c3', ['src/new.ts']);
  });
});
