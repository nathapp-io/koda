import { Logger } from '@nestjs/common';
import { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { chunkMarkdown } from './markdown-chunker';
import { FakeEmbeddingProvider } from '../../rag/providers/fake-embedding.provider';
import type { IKnowledgeIndexRepository, KnowledgeFileState } from './knowledge-index.domain';
import type { GitHubAppClient } from '../git-broker/github-app-client';
import type { KnowledgeChunkStore } from './knowledge-chunk-store';
import type { EmbeddingService } from '../../rag/embedding.service';
import type { RagService } from '../../rag/rag.service';
import type { LanceRecord } from '../../rag/lance-table-manager';

const now = new Date('2026-10-16T00:00:00Z');
const text = `## Alpha\n${'a'.repeat(500)}\n\n## Beta\n${'b'.repeat(500)}`;
const entry = (path: string) => ({ path, type: 'blob' as const, sha: `blob-${path}`, size: 1100 });
const stored = (path: string, unembeddedCount = 0): KnowledgeFileState => ({ repoId: 'r1', path, blobSha: entry(path).sha, chunkCount: 3, unembeddedCount });

function fixture(paths = ['docs/a.md']) {
  const repo = { id: 'r1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: 5n };
  const state = {
    findRepo: vi.fn().mockResolvedValue(repo), claim: vi.fn().mockResolvedValue(true), renew: vi.fn().mockResolvedValue(true),
    listStates: vi.fn().mockResolvedValue([]), listFiles: vi.fn().mockResolvedValue([]),
    finish: vi.fn().mockResolvedValue(undefined), upsertFile: vi.fn().mockResolvedValue(undefined), deleteFile: vi.fn().mockResolvedValue(undefined),
  };
  const github = {
    mintReadOnlyToken: vi.fn().mockResolvedValue({ token: 'secret', expiresAt: now }), getBranchHead: vi.fn().mockResolvedValue('head'),
    getTree: vi.fn().mockResolvedValue({ entries: paths.map(entry), truncated: false }),
    getFile: vi.fn().mockResolvedValue({ content: Buffer.from(text), sha: 'blob', size: text.length }),
  };
  const store = { replaceFile: vi.fn().mockResolvedValue(undefined), deleteFile: vi.fn().mockResolvedValue(undefined) };
  const fake = new FakeEmbeddingProvider();
  const embeddings = { dimensions: fake.dimensions, providerName: fake.name, modelName: 'fake-model', embedBatch: vi.fn((contents: string[]) => fake.embedBatch(contents)) };
  const rag = { optimizeTable: vi.fn().mockResolvedValue(undefined) };
  const clock = vi.fn(() => now.getTime() + 1000);
  const indexer = new KnowledgeRepoIndexer(state as unknown as IKnowledgeIndexRepository, github as unknown as GitHubAppClient,
    store as unknown as KnowledgeChunkStore, embeddings as unknown as EmbeddingService, rag as unknown as RagService, clock);
  return { indexer, state, github, store, embeddings, rag, repo, clock };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('KnowledgeRepoIndexer', () => {
  it('AC-1: mints read-only then reads default branch head and recursive tree in order', async () => {
    const f = fixture();
    await f.indexer.indexRepo('r1', now);
    expect(f.github.mintReadOnlyToken).toHaveBeenCalledWith(5n, 'n');
    expect(f.github.getBranchHead).toHaveBeenCalledWith('secret', 'o', 'n', 'main');
    expect(f.github.getTree).toHaveBeenCalledWith('secret', 'o', 'n', 'head', true);
    expect(f.github.mintReadOnlyToken.mock.invocationCallOrder[0]).toBeLessThan(f.github.getBranchHead.mock.invocationCallOrder[0]);
    expect(f.github.getBranchHead.mock.invocationCallOrder[0]).toBeLessThan(f.github.getTree.mock.invocationCallOrder[0]);
    expect(f.state.claim).toHaveBeenCalledWith('r1', 'p1', now, 900_000);
  });

  it('AC-2: fetches exactly allowlisted paths at head', async () => {
    const f = fixture(['README.md', 'docs/a.md', '.nax/features/f1/prd.json', 'src/a.ts']);
    await f.indexer.indexRepo('r1', now);
    expect(f.github.getFile.mock.calls).toEqual([
      ['secret', 'o', 'n', 'README.md', 'head'], ['secret', 'o', 'n', 'docs/a.md', 'head'],
    ]);
  });

  it('AC-3: writes chunker rows with complete context, metadata and embeddings', async () => {
    const f = fixture();
    await f.indexer.indexRepo('r1', now);
    expect(f.store.replaceFile).toHaveBeenCalledTimes(1);
    const [project, source, rows] = f.store.replaceFile.mock.calls[0] as [string, string, LanceRecord[]];
    expect([project, source]).toEqual(['p1', 'repo:r1:docs/a.md']);
    const chunks = chunkMarkdown({ path: 'docs/a.md', text });
    expect(rows).toHaveLength(3);
    rows.forEach((row, i) => {
      expect(row).toMatchObject({ id: `repo:r1:docs/a.md#${i}`, source: 'repo', source_id: source, created_at: now.toISOString(), provider: f.embeddings.providerName, model: 'fake-model' });
      expect(JSON.parse(row.metadata)).toEqual({ ...chunks[i], repoId: 'r1', owner: 'o', name: 'n', path: 'docs/a.md', sha: 'head', blobSha: entry('docs/a.md').sha, chunkCount: 3 });
      expect(row.content).toBe(`o/n · docs/a.md${chunks[i].headingPath ? ` · ${chunks[i].headingPath}` : ''}\n${chunks[i].abstract}\n\n${chunks[i].text}`);
    });
    expect(f.embeddings.embedBatch).toHaveBeenCalledWith(rows.map(row => row.content));
  });

  it('AC-4: leaves a matching fully embedded blob alone', async () => {
    const f = fixture(); f.state.listFiles.mockResolvedValue([stored('docs/a.md')]);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });
    expect(f.github.getFile).not.toHaveBeenCalled(); expect(f.store.replaceFile).not.toHaveBeenCalled();
    expect(f.rag.optimizeTable).not.toHaveBeenCalled();
  });

  it.each(['absent', 'null'])('AC-5: deletes chunks and file row for %s file', async mode => {
    const path = mode === 'absent' ? 'docs/gone.md' : 'docs/null.md';
    const f = fixture(mode === 'absent' ? [] : [path]); f.state.listFiles.mockResolvedValue([{ ...stored(path), blobSha: 'old' }]);
    f.github.getFile.mockResolvedValue(null);
    await f.indexer.indexRepo('r1', now);
    expect(f.store.deleteFile).toHaveBeenCalledWith('p1', `repo:r1:${path}`);
    expect(f.state.deleteFile).toHaveBeenCalledWith('r1', path);
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ fileCount: 0, chunkCount: 0 }));
    expect(f.rag.optimizeTable).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'count', 'dimensions', 'timeout'])('AC-6: stores retryable zero vectors on embedding %s', async mode => {
    const f = fixture();
    const warning = vi.spyOn(Logger.prototype, 'warn'); warning.mockClear();
    if (mode === 'throw') f.embeddings.embedBatch.mockRejectedValue(new Error('embedding failed'));
    if (mode === 'count') f.embeddings.embedBatch.mockResolvedValue([Array(f.embeddings.dimensions).fill(1)]);
    if (mode === 'dimensions') f.embeddings.embedBatch.mockResolvedValue([[1], [1], [1]]);
    if (mode === 'timeout') { vi.useFakeTimers(); f.embeddings.embedBatch.mockImplementation(() => new Promise(() => {})); }
    const pass = f.indexer.indexRepo('r1', now);
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
    expect(await pass).toEqual({ status: 'indexed' });
    const rows = f.store.replaceFile.mock.calls[0][2] as LanceRecord[];
    rows.forEach(row => expect(row).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) }));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: rows.length, chunkCount: rows.length }));
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each([0, 3])('AC-7: same head retries only unembedded files (count %i)', async unembedded => {
    const f = fixture(['docs/a.md', 'docs/b.md']);
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', fileCount: 2, chunkCount: 6, unembeddedCount: unembedded, skippedCount: 7 }]);
    f.state.listFiles.mockResolvedValue([stored('docs/a.md', unembedded), stored('docs/b.md')]);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: unembedded ? 'indexed' : 'unchanged' });
    if (unembedded) expect(f.github.getFile.mock.calls).toEqual([['secret', 'o', 'n', 'docs/a.md', 'head']]);
    else {
      expect(f.github.getTree).not.toHaveBeenCalled();
      expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', fileCount: 2, chunkCount: 6, skippedCount: 7 }));
    }
  });

  it('AC-8: stops all commits and never finishes after first failed renew', async () => {
    const f = fixture(['docs/a.md', 'docs/b.md', 'docs/c.md']); f.state.renew.mockResolvedValue(false);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'lease lost' });
    expect(f.store.replaceFile).toHaveBeenCalledTimes(1); expect(f.state.finish).not.toHaveBeenCalled();
    expect(f.state.upsertFile).not.toHaveBeenCalled(); expect(f.rag.optimizeTable).not.toHaveBeenCalled();
  });

  it.each([['gitlab', 5n, 'not a GitHub repository'], ['github', null, 'no installation']])('AC-9: skips %s installation %s', async (provider, installation, reason) => {
    const f = fixture(); f.state.findRepo.mockResolvedValue({ ...f.repo, provider, githubInstallationId: installation });
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'skipped', reason });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'skipped', lastError: reason }));
    Object.values(f.github).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });

  it('AC-10: busy does no forge or store work', async () => {
    const f = fixture(); f.state.claim.mockResolvedValue(false);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'busy' });
    [...Object.values(f.github), ...Object.values(f.store), f.state.finish, f.state.listFiles].forEach(fn => expect(fn).not.toHaveBeenCalled());
  });

  it('AC-11: truncated tree fails without advancing sha or writing chunks', async () => {
    const f = fixture(); f.github.getTree.mockResolvedValue({ entries: [], truncated: true });
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'tree truncated' });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'failed', lastError: 'tree truncated', leaseUntil: null }));
    expect(f.state.finish.mock.calls[0][1]).not.toHaveProperty('indexedSha');
    expect(f.store.replaceFile).not.toHaveBeenCalled();
  });

  it.each(['mint', 'file', 'store'])('AC-12: %s failures finish failed without advancing sha', async mode => {
    const f = fixture();
    const error = mode === 'mint' ? new RepoCheckException('app_not_installed') : mode === 'file' ? new Error('boom') : new KnowledgeStoreUnavailableError();
    if (mode === 'mint') f.github.mintReadOnlyToken.mockRejectedValue(error);
    if (mode === 'file') f.github.getFile.mockRejectedValue(error);
    if (mode === 'store') f.store.replaceFile.mockRejectedValue(error);
    const reason = mode === 'mint' ? 'app_not_installed' : error.message;
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'failed', lastError: reason, leaseUntil: null }));
    expect(f.state.finish.mock.calls[0][1]).not.toHaveProperty('indexedSha');
  });

  it('AC-13: successful pass records durable totals and optimizes once', async () => {
    const f = fixture(); expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });
    expect(f.rag.optimizeTable).toHaveBeenCalledExactlyOnceWith('p1');
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', indexedSha: 'head', fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0, lastError: null, leaseUntil: null, finishedAt: expect.any(Date) }));
  });

  it('AC-14: unknown repo never writes state', async () => {
    const f = fixture(); f.state.findRepo.mockResolvedValue(null);
    expect(await f.indexer.indexRepo('unknown', now)).toEqual({ status: 'failed', reason: 'unknown repo' });
    [f.state.claim, f.state.renew, f.state.finish, f.state.upsertFile, f.state.deleteFile].forEach(fn => expect(fn).not.toHaveBeenCalled());
  });

  it('optimizes after finishing idle, and restores the prior SHA if optimization fails', async () => {
    const f = fixture();
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'old-head' }]);
    f.rag.optimizeTable.mockRejectedValue(new KnowledgeStoreUnavailableError());
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: new KnowledgeStoreUnavailableError().message });
    expect(f.state.finish.mock.calls[0][1]).toMatchObject({ status: 'idle', indexedSha: 'head' });
    expect(f.state.finish.mock.invocationCallOrder[0]).toBeLessThan(f.rag.optimizeTable.mock.invocationCallOrder[0]);
    expect(f.state.finish.mock.calls[1][1]).toMatchObject({ status: 'failed', indexedSha: 'old-head' });
  });

  it('never persists a minted token included in a collaborator error', async () => {
    const f = fixture(); f.github.getFile.mockRejectedValue(new Error('request secret failed'));
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'request [REDACTED] failed' });
    expect(JSON.stringify(f.state.finish.mock.calls)).not.toContain('secret');
  });

  it('decodes invalid UTF-8 as replacement characters', async () => {
    const f = fixture(); f.github.getFile.mockResolvedValue({ content: Buffer.from([0x61, 0xff, 0x62]), sha: 'blob', size: 3 });
    await f.indexer.indexRepo('r1', now);
    const rows = f.store.replaceFile.mock.calls[0][2] as LanceRecord[];
    expect(rows.some(row => row.content.includes('a\uFFFDb'))).toBe(true);
  });

  it('counts allowlist skips and preserves the cap notice', async () => {
    const f = fixture(Array.from({ length: 2001 }, (_, i) => `docs/${i}.md`));
    f.state.listFiles.mockResolvedValue(Array.from({ length: 2000 }, (_, i) => stored(`docs/${i}.md`)));
    await f.indexer.indexRepo('r1', now);
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ skippedCount: 1, lastError: '2000-file cap reached', fileCount: 2000 }));
    expect(f.github.getFile).not.toHaveBeenCalled();
  });

  it('cuts persisted errors to 500 characters', async () => {
    const f = fixture(); f.github.getBranchHead.mockRejectedValue(new Error('x'.repeat(600)));
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'x'.repeat(500) });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ lastError: 'x'.repeat(500) }));
  });

  it('AC-15: serializes commits with a renewal after each replacement', async () => {
    const f = fixture(['docs/a.md', 'docs/b.md', 'docs/c.md']);
    await f.indexer.indexRepo('r1', now);
    expect(f.state.renew).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(f.state.renew.mock.calls[i].slice(0, 2)).toEqual(['r1', new Date(f.clock() + 900_000)]);
      expect(f.store.replaceFile.mock.invocationCallOrder[i]).toBeLessThan(f.state.renew.mock.invocationCallOrder[i]);
      if (i < 2) expect(f.state.renew.mock.invocationCallOrder[i]).toBeLessThan(f.store.replaceFile.mock.invocationCallOrder[i + 1]);
    }
  });
});
