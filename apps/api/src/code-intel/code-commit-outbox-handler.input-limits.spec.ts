import type { Mock } from 'vitest';
vi.mock('../vcs/factory', () => ({ createVcsProvider: vi.fn() }));
vi.mock('../common/utils/encryption.util', () => ({ decryptToken: vi.fn().mockReturnValue('plain') }));

import { createVcsProvider } from '../vcs/factory';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { MAX_INDEX_BATCH_FILES, MAX_INDEX_FILE_BYTES } from './index-input-limits';
import type { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import type { AstIndexService } from './ast-index.service';
import type { IVcsConfig } from '../config/vcs.config';

describe('CodeCommitOutboxHandler input limits (#534)', () => {
  let ast: { indexCommit: Mock; removeFiles: Mock };
  let fetchCommitFiles: Mock;
  let findConnection: Mock;
  let handler: CodeCommitOutboxHandler;

  const event = (changedFiles: string[]) => ({
    repoId: 'acme/widgets', commitHash: 'c1', ref: 'refs/heads/main', projectId: 'p1', changedFiles,
  });

  beforeEach(() => {
    ast = { indexCommit: vi.fn(), removeFiles: vi.fn() };
    fetchCommitFiles = vi.fn(async (_repo: string, _commit: string, paths: string[]) => paths.map((path) => ({ path, content: 'x' })));
    (createVcsProvider as Mock).mockReturnValue({ fetchCommitFiles });
    findConnection = vi.fn().mockResolvedValue({ provider: 'github', repoOwner: 'acme', repoName: 'widgets', encryptedToken: 'enc' });
    handler = new CodeCommitOutboxHandler(
      { findVcsConnectionByProjectId: findConnection } as unknown as PrismaCodeIntelRepository,
      ast as unknown as AstIndexService,
      { encryptionKey: 'ab'.repeat(32), githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4', defaultPollingIntervalMs: 1 } as IVcsConfig,
    );
  });

  it('fetches only the paths the extractor understands', async () => {
    await handler.process(event(['src/a.ts', 'bun.lock', 'openapi.json', 'docs/readme.md', 'web/b.tsx']));

    expect(fetchCommitFiles).toHaveBeenCalledWith('acme/widgets', 'c1', ['src/a.ts', 'web/b.tsx']);
    expect(ast.indexCommit).toHaveBeenCalledTimes(1);
    expect(ast.indexCommit.mock.calls[0][2].map((f: { path: string }) => f.path)).toEqual(['src/a.ts', 'web/b.tsx']);
  });

  it('does not look up the connection or fetch when no changed path is indexable', async () => {
    await handler.process(event(['bun.lock', 'README.md']));

    expect(findConnection).not.toHaveBeenCalled();
    expect(fetchCommitFiles).not.toHaveBeenCalled();
    expect(ast.indexCommit).not.toHaveBeenCalled();
  });

  it('does not parse an oversized file and drops the symbols it had', async () => {
    fetchCommitFiles.mockResolvedValue([
      { path: 'src/small.ts', content: 'x' },
      { path: 'src/huge.ts', content: 'x'.repeat(MAX_INDEX_FILE_BYTES + 1) },
    ]);

    await handler.process(event(['src/small.ts', 'src/huge.ts']));

    expect(ast.removeFiles).toHaveBeenCalledWith('p1', 'acme/widgets', ['src/huge.ts']);
    expect(ast.indexCommit).toHaveBeenCalledTimes(1);
    expect(ast.indexCommit.mock.calls[0][2]).toEqual([{ path: 'src/small.ts', content: 'x' }]);
  });

  it('does not call indexCommit when every fetched file is oversized', async () => {
    fetchCommitFiles.mockResolvedValue([{ path: 'src/huge.ts', content: 'x'.repeat(MAX_INDEX_FILE_BYTES + 1) }]);

    await handler.process(event(['src/huge.ts']));

    expect(ast.removeFiles).toHaveBeenCalledWith('p1', 'acme/widgets', ['src/huge.ts']);
    expect(ast.indexCommit).not.toHaveBeenCalled();
  });

  it('indexes a commit above the batch cap in several batches, passing onIndexed to each', async () => {
    const paths = Array.from({ length: MAX_INDEX_BATCH_FILES + 2 }, (_, i) => `src/f${i}.ts`);
    const onIndexed = vi.fn();

    await handler.process(event(paths), onIndexed);

    expect(ast.indexCommit).toHaveBeenCalledTimes(2);
    expect(ast.indexCommit.mock.calls.map((call) => call[2].length)).toEqual([MAX_INDEX_BATCH_FILES, 2]);
    expect(ast.indexCommit.mock.calls.flatMap((call) => call[2].map((f: { path: string }) => f.path))).toEqual(paths);
    for (const call of ast.indexCommit.mock.calls) {
      expect(call.slice(0, 2)).toEqual(['acme/widgets', 'c1']);
      expect(call[3]).toBe('p1');
      expect(call[4]).toBe(onIndexed);
    }
  });
});
