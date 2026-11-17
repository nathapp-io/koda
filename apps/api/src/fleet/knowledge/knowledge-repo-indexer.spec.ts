import { Logger } from '@nestjs/common';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { KnowledgeRepoIndexer } from './knowledge-repo-indexer';
import { KnowledgeStoreUnavailableError } from './knowledge-chunk-store';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { chunkMarkdown } from './markdown-chunker';
import { KNOWLEDGE_CAP_MESSAGE, MAX_KNOWLEDGE_FILE_BYTES } from './knowledge-allowlist';
import { FakeEmbeddingProvider } from '../../rag/providers/fake-embedding.provider';
import type { IKnowledgeIndexRepository, KnowledgeFileState } from './knowledge-index.domain';
import type { RunOutcomeRow } from '../ingest/domain/bundle-ingest.domain';
import type { GitHubAppClient } from '../git-broker/github-app-client';
import type { KnowledgeChunkStore } from './knowledge-chunk-store';
import type { EmbeddingService } from '../../rag/embedding.service';
import type { RagService } from '../../rag/rag.service';
import type { LanceRecord } from '../../rag/lance-table-manager';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import type { IGitLabCredentialRepository } from '../git-broker/prisma-gitlab-credential.repository';
import type { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { encryptToken } from '../../common/utils/encryption.util';

const now = new Date('2026-10-16T00:00:00Z');
const text = `## Alpha\n${'a'.repeat(500)}\n\n## Beta\n${'b'.repeat(500)}`;
const entry = (path: string) => ({ path, type: 'blob' as const, sha: `blob-${path}`, size: 1100 });
const stored = (path: string, unembeddedCount = 0): KnowledgeFileState => ({ repoId: 'r1', path, blobSha: entry(path).sha, chunkCount: 3, unembeddedCount });

/** US-002: 39 sections over the 200-character merge rule, so the file chunks as summary + 39 (40 rows). */
const bigText = (): string => Array.from({ length: 39 }, (_, i) => `## S${i + 1}\n${'x'.repeat(250)}`).join('\n\n');

/** The stored content of each chunk of the US-002 fixture file, in chunk order. */
const bigContents = (path = 'docs/big.md'): string[] => chunkMarkdown({ path, text: bigText() })
  .map(chunk => `o/n · ${path}${chunk.headingPath ? ` · ${chunk.headingPath}` : ''}\n${chunk.abstract}\n\n${chunk.text}`);

/** The key the GitLab credential store decrypts under; 32 bytes of hex, as `VCS_ENCRYPTION_KEY` holds it. */
const GITLAB_KEY = 'a'.repeat(64);
/** US-004: the two tokens differ, so a read access's token proves which token kind was resolved. */
const GITLAB_READ_TOKEN = 'gitlab-read-token';
const GITLAB_WRITE_TOKEN = 'gitlab-write-token';

interface FixtureOptions {
  /** US-004: the repo is a GitLab one, with a credential row unless `gitlabConnected` is false. */
  gitlab?: boolean;
  gitlabConnected?: boolean;
}

function fixture(paths = ['docs/a.md'], fileText = text, over: FixtureOptions = {}) {
  const repo = over.gitlab
    ? {
      id: 'r1', projectId: 'p1', provider: 'gitlab', owner: 'o', name: 'n', defaultBranch: 'main',
      host: 'https://gitlab.example.com', githubInstallationId: null, gitlabConnected: over.gitlabConnected ?? true,
    }
    : { id: 'r1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main', githubInstallationId: 5n };
  const state = {
    findRepo: vi.fn().mockResolvedValue(repo), claim: vi.fn().mockResolvedValue(true), renew: vi.fn().mockResolvedValue(true),
    listStates: vi.fn().mockResolvedValue([]), listFiles: vi.fn().mockResolvedValue([]),
    // US-002: a project that saved no patterns; a test that saves some overrides this.
    findProjectPatterns: vi.fn().mockResolvedValue(null),
    finish: vi.fn().mockResolvedValue(undefined), upsertFile: vi.fn().mockResolvedValue(undefined), deleteFile: vi.fn().mockResolvedValue(undefined),
  };
  const github = {
    mintReadOnlyToken: vi.fn().mockResolvedValue({ token: 'secret', expiresAt: now }), getBranchHead: vi.fn().mockResolvedValue('head'),
    getTree: vi.fn().mockResolvedValue({ entries: paths.map(entry), truncated: false }),
    getFile: vi.fn().mockResolvedValue({ content: Buffer.from(fileText), sha: 'blob', size: fileText.length }),
  };
  // US-004: a GitLab tree entry carries no size, and its blob id is what a file read reports back.
  const gitlabEntry = (path: string) => ({ path, type: 'blob' as const, sha: `blob-${path}`, size: null });
  const gitlabChecker = {
    getBranchHead: vi.fn().mockResolvedValue('gl-head'),
    getTree: vi.fn().mockResolvedValue({ entries: paths.map(gitlabEntry), truncated: false }),
    getFile: vi.fn().mockResolvedValue({ content: Buffer.from(fileText), sha: 'blob', size: fileText.length }),
  };
  // US-004: the production credential store over an in-memory row, so `call` (and its invalid mark) is real.
  const markInvalid = vi.fn(async () => undefined);
  const credentialRow = over.gitlab === true && (over.gitlabConnected ?? true)
    ? {
      repoId: 'r1', gitlabProjectId: 42,
      encryptedReadToken: encryptToken(GITLAB_READ_TOKEN, GITLAB_KEY), encryptedWriteToken: encryptToken(GITLAB_WRITE_TOKEN, GITLAB_KEY),
      readTokenUserId: 1, readTokenUsername: 'reader', writeTokenUserId: 2, writeTokenUsername: 'writer', writeTokenIsBot: true,
      readTokenExpiresAt: null, writeTokenExpiresAt: null, readTokenInvalidAt: null, writeTokenInvalidAt: null,
    }
    : null;
  const credentials = new GitLabRepoCredentials(
    { findByRepoId: vi.fn(async () => credentialRow), markInvalid, upsert: vi.fn() } as unknown as IGitLabCredentialRepository,
    { encryptionKey: GITLAB_KEY },
  );
  const store = { replaceFile: vi.fn().mockResolvedValue(undefined), deleteFile: vi.fn().mockResolvedValue(undefined) };
  const fake = new FakeEmbeddingProvider();
  const embeddings = {
    dimensions: fake.dimensions, providerName: fake.name, modelName: 'fake-model',
    embedBatch: vi.fn((contents: string[]) => fake.embedBatch(contents)),
    embed: vi.fn((content: string) => fake.embed(content)),
  };
  const rag = { optimizeTable: vi.fn().mockResolvedValue(undefined) };
  const clock = vi.fn(() => now.getTime() + 1000);
  const audit = { audited: vi.fn(async <T>(fn: () => Promise<T>, entriesOf: (result: T) => unknown[]) => { const result = await fn(); entriesOf(result); return result; }), record: vi.fn() };
  const indexer = new KnowledgeRepoIndexer(state as unknown as IKnowledgeIndexRepository, github as unknown as GitHubAppClient,
    store as unknown as KnowledgeChunkStore, embeddings as unknown as EmbeddingService, rag as unknown as RagService, audit as never,
    credentials, gitlabChecker as unknown as GitLabAccessChecker, clock);
  return {
    indexer, state, github, store, embeddings, rag, repo, clock, fake, audit, credentials, gitlabChecker, markInvalid,
  };
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
    // A failed batch is retried one chunk at a time, so the single-chunk route must fail too.
    f.embeddings.embed.mockRejectedValue(new Error('embedding failed'));
    const pass = f.indexer.indexRepo('r1', now);
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
    expect(await pass).toEqual({ status: 'indexed' });
    const rows = f.store.replaceFile.mock.calls[0][2] as LanceRecord[];
    rows.forEach(row => expect(row).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) }));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: rows.length, chunkCount: rows.length }));
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it.each([0, 3])('AC-7: same head retries only unembedded files (count %i)', async unembedded => {
    const f = fixture(['docs/a.md', 'docs/b.md']);
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', patternsKey: 'default', fileCount: 2, chunkCount: 6, unembeddedCount: unembedded, skippedCount: 7 }]);
    f.state.listFiles.mockResolvedValue([stored('docs/a.md', unembedded), stored('docs/b.md')]);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: unembedded ? 'indexed' : 'unchanged' });
    if (unembedded) expect(f.github.getFile.mock.calls).toEqual([['secret', 'o', 'n', 'docs/a.md', 'head']]);
    else {
      expect(f.github.getTree).not.toHaveBeenCalled();
      expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', fileCount: 2, chunkCount: 6, skippedCount: 7 }));
    }
  });

  it.each([
    ['clears a failure reason', 'provider_unreachable', null],
    ['keeps the cap message', KNOWLEDGE_CAP_MESSAGE, KNOWLEDGE_CAP_MESSAGE],
  ])('#350: an unchanged pass %s', async (_label, lastError, expected) => {
    const f = fixture();
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', patternsKey: 'default', fileCount: 1, chunkCount: 3, unembeddedCount: 0, lastError }]);
    f.state.listFiles.mockResolvedValue([stored('docs/a.md')]);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'unchanged' });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', lastError: expected }));
  });

  it('AC-8: stops all commits and never finishes after first failed renew', async () => {
    const f = fixture(['docs/a.md', 'docs/b.md', 'docs/c.md']); f.state.renew.mockResolvedValue(false);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'lease lost' });
    expect(f.store.replaceFile).toHaveBeenCalledTimes(1); expect(f.state.finish).not.toHaveBeenCalled();
    expect(f.state.upsertFile).not.toHaveBeenCalled(); expect(f.rag.optimizeTable).not.toHaveBeenCalled();
  });

  it.each([
    // US-004: a GitLab repo is indexed through its read token, so only a missing credential row skips it.
    ['gitlab', 5n, 'no credentials', false],
    ['github', null, 'no installation', undefined],
  ])('AC-9: skips %s installation %s', async (provider, installation, reason, gitlabConnected) => {
    const f = fixture(); f.state.findRepo.mockResolvedValue({ ...f.repo, provider, githubInstallationId: installation, gitlabConnected });
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'skipped', reason });
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'skipped', lastError: reason }));
    Object.values(f.github).forEach(fn => expect(fn).not.toHaveBeenCalled());
    Object.values(f.gitlabChecker).forEach(fn => expect(fn).not.toHaveBeenCalled());
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

  it('US-008 AC-10: audits changed and removed files at the successful checkpoint', async () => {
    const f = fixture(['docs/a.md', 'docs/b.md']);
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'old' }]);
    f.state.listFiles.mockResolvedValue([{ ...stored('docs/a.md'), blobSha: 'old-a' }, { ...stored('docs/b.md'), blobSha: 'old-b' }, stored('docs/old.md')]);
    await f.indexer.indexRepo('r1', now);
    expect(f.audit.audited).toHaveBeenCalledTimes(1);
    expect(f.audit.audited.mock.calls[0]?.[1]({ status: 'indexed' })).toEqual([{
      key: 'system.knowledge.index', resourceType: 'fleet-repo', resourceId: 'r1', projectId: 'p1', summary: 'indexed 2 changed, 1 removed',
    }]);
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', indexedSha: 'head' }));
  });

  it('US-008: retrying an unchanged blob with unembedded chunks is not counted as changed', async () => {
    const f = fixture();
    f.state.listFiles.mockResolvedValue([stored('docs/a.md', 2)]);
    await f.indexer.indexRepo('r1', now);
    expect(f.audit.audited.mock.calls[0]?.[1]({ status: 'indexed' })).toEqual([expect.objectContaining({ summary: 'indexed 0 changed, 0 removed' })]);
  });

  it('US-008 AC-11: unchanged state does not audit', async () => {
    const f = fixture();
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', patternsKey: 'default', fileCount: 0, chunkCount: 0, unembeddedCount: 0 }]);
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'unchanged' });
    expect(f.audit.audited).not.toHaveBeenCalled();
  });

  it('US-008 AC-12: skipped repositories do not audit', async () => {
    const f = fixture(); f.state.findRepo.mockResolvedValue({ ...f.repo, provider: 'gitlab' });
    expect((await f.indexer.indexRepo('r1', now)).status).toBe('skipped');
    expect(f.audit.audited).not.toHaveBeenCalled();
  });

  it('US-008 AC-13: busy repositories do not audit', async () => {
    const f = fixture(); f.state.claim.mockResolvedValue(false);
    expect((await f.indexer.indexRepo('r1', now)).status).toBe('busy');
    expect(f.audit.audited).not.toHaveBeenCalled();
  });

  it('US-008 AC-14: failed audit returns failed and records failed finish', async () => {
    const f = fixture();
    f.audit.audited.mockRejectedValue(new Error('audit down'));
    expect((await f.indexer.indexRepo('r1', now)).status).toBe('failed');
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'failed' }));
  });

  it('AC-14: unknown repo never writes state', async () => {
    const f = fixture(); f.state.findRepo.mockResolvedValue(null);
    expect(await f.indexer.indexRepo('unknown', now)).toEqual({ status: 'failed', reason: 'unknown repo' });
    [f.state.claim, f.state.renew, f.state.finish, f.state.upsertFile, f.state.deleteFile].forEach(fn => expect(fn).not.toHaveBeenCalled());
  });

  it('optimizes after finishing idle, and restores the prior SHA if optimization fails', async () => {
    const f = fixture();
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'old-head' }]);
    const committedEntries: unknown[] = [];
    let inAudit = false;
    f.audit.audited.mockImplementation(async (fn, entriesOf) => {
      inAudit = true;
      try {
        const result = await fn();
        committedEntries.push(...entriesOf(result));
        return result;
      } finally { inAudit = false; }
    });
    f.rag.optimizeTable.mockImplementation(async () => {
      expect(inAudit).toBe(false);
      throw new KnowledgeStoreUnavailableError();
    });
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: new KnowledgeStoreUnavailableError().message });
    expect(f.state.finish.mock.calls[0][1]).toMatchObject({ status: 'idle', indexedSha: 'head' });
    expect(f.state.finish.mock.invocationCallOrder[0]).toBeLessThan(f.rag.optimizeTable.mock.invocationCallOrder[0]);
    expect(f.state.finish.mock.calls[1][1]).toMatchObject({ status: 'failed', indexedSha: 'old-head' });
    expect(committedEntries).toEqual([expect.objectContaining({ key: 'system.knowledge.index', summary: 'indexed 1 changed, 0 removed' })]);
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

/**
 * US-002: the file's chunks are embedded in batches of 16 through one embedding server, and a failure
 * costs only the chunks that failed. Every count below is a literal, matching the acceptance criteria.
 */
describe('KnowledgeRepoIndexer batched embedding (US-002)', () => {
  const bigFile = (): ReturnType<typeof fixture> => fixture(['docs/big.md'], bigText());
  const rowsOf = (f: ReturnType<typeof fixture>): LanceRecord[] => f.store.replaceFile.mock.calls[0][2] as LanceRecord[];

  /** Records how many calls were already in flight when each call started: `[0, 0, ...]` means one at a time. */
  function startsOf(embed: { mockImplementation: (fn: never) => unknown }, fake: FakeEmbeddingProvider): number[] {
    const starts: number[] = [];
    let inFlight = 0;
    embed.mockImplementation((async (input: string[] | string) => {
      starts.push(inFlight);
      inFlight += 1;
      try {
        return Array.isArray(input) ? await fake.embedBatch(input) : await fake.embed(input);
      } finally {
        inFlight -= 1;
      }
    }) as never);
    return starts;
  }

  it('AC-5: embeds a 40-chunk file in three batches of 16, 16 and 8, one at a time', async () => {
    const f = bigFile();
    const contents = bigContents();
    const starts = startsOf(f.embeddings.embedBatch, f.fake);
    await f.indexer.indexRepo('r1', now);
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(3);
    expect(f.embeddings.embedBatch.mock.calls.map(call => call[0])).toEqual([contents.slice(0, 16), contents.slice(16, 32), contents.slice(32)]);
    expect(starts).toEqual([0, 0, 0]);
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    const rows = rowsOf(f);
    expect(rows).toHaveLength(40);
    expect(rows.map(row => row.content)).toEqual(contents);
    rows.forEach(row => expect(row.provider).toBe(f.fake.name));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 0, chunkCount: 40 }));
  });

  it('AC-6: retries a rejected batch one chunk at a time, one at a time', async () => {
    const f = bigFile();
    const contents = bigContents();
    f.embeddings.embedBatch.mockImplementation((batch: string[]) =>
      (batch[0] === contents[16] ? Promise.reject(new Error('batch down')) : f.fake.embedBatch(batch)));
    const starts = startsOf(f.embeddings.embed, f.fake);
    await f.indexer.indexRepo('r1', now);
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(3);
    expect(f.embeddings.embed.mock.calls.map(call => call[0])).toEqual(contents.slice(16, 32));
    expect(starts).toEqual(new Array(16).fill(0));
    const rows = rowsOf(f);
    expect(rows).toHaveLength(40);
    expect(rows.every(row => row.provider === f.fake.name && row.model === 'fake-model')).toBe(true);
    expect(rows[16].vector).toEqual(await f.fake.embed(contents[16]));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 0 }));
  });

  it('AC-7: a failing single-chunk retry leaves only that chunk unembedded', async () => {
    const f = bigFile();
    const contents = bigContents();
    const failed = contents[16 + 3];
    f.embeddings.embedBatch.mockImplementation((batch: string[]) =>
      (batch[0] === contents[16] ? Promise.reject(new Error('batch down')) : f.fake.embedBatch(batch)));
    f.embeddings.embed.mockImplementation((content: string) =>
      (content === failed ? Promise.reject(new Error('chunk down')) : f.fake.embed(content)));
    await f.indexer.indexRepo('r1', now);
    const rows = rowsOf(f);
    expect(rows).toHaveLength(40);
    expect(rows[19]).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0), content: failed });
    rows.filter((_, index) => index !== 19).forEach(row => expect(row.provider).toBe(f.fake.name));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 1 }));
  });

  it('AC-7 boundary: a retry that resolves a non-array leaves that chunk unembedded, not the file failed', async () => {
    const f = bigFile();
    const contents = bigContents();
    f.embeddings.embedBatch.mockImplementation((batch: string[]) =>
      (batch[0] === contents[16] ? Promise.reject(new Error('batch down')) : f.fake.embedBatch(batch)));
    f.embeddings.embed.mockImplementation((content: string) =>
      (content === contents[19] ? Promise.resolve(undefined as unknown as number[]) : f.fake.embed(content)));
    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });
    const rows = rowsOf(f);
    expect(rows[19]).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) });
    rows.filter((_, index) => index !== 19).forEach(row => expect(row.provider).toBe(f.fake.name));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 1 }));
  });

  it('AC-8: a batch that times out is unembedded with no per-chunk retry, and later batches still run', async () => {
    vi.useFakeTimers();
    const f = bigFile();
    const contents = bigContents();
    f.embeddings.embedBatch.mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation((batch: string[]) => f.fake.embedBatch(batch));
    const pass = f.indexer.indexRepo('r1', now);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await pass).toEqual({ status: 'indexed' });
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(3);
    expect(f.embeddings.embedBatch.mock.calls[2][0]).toEqual(contents.slice(32));
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    const rows = rowsOf(f);
    expect(rows).toHaveLength(40);
    rows.slice(0, 16).forEach(row => expect(row).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) }));
    rows.slice(16).forEach(row => expect(row.provider).toBe(f.fake.name));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 16 }));
  });

  it('AC-9: a batch with a wrong-length vector is retried one chunk at a time', async () => {
    const f = bigFile();
    const contents = bigContents();
    f.embeddings.embedBatch.mockImplementation(async (batch: string[]) => {
      const vectors = await f.fake.embedBatch(batch);
      return batch[0] === contents[0] ? [[0.5], ...vectors.slice(1)] : vectors;
    });
    await f.indexer.indexRepo('r1', now);
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(3);
    expect(f.embeddings.embed.mock.calls.map(call => call[0])).toEqual(contents.slice(0, 16));
    const rows = rowsOf(f);
    expect(rows.every(row => row.provider === f.fake.name)).toBe(true);
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 0 }));
  });

  it('AC-10: batches after the 300-second file deadline are not requested', async () => {
    const f = bigFile();
    const contents = bigContents();
    const started = now.getTime();
    f.clock.mockReturnValueOnce(started).mockReturnValueOnce(started).mockReturnValue(started + 300_000);
    await f.indexer.indexRepo('r1', now);
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(1);
    expect(f.embeddings.embedBatch.mock.calls[0][0]).toEqual(contents.slice(0, 16));
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    const rows = rowsOf(f);
    expect(rows).toHaveLength(40);
    rows.slice(0, 16).forEach(row => expect(row.provider).toBe(f.fake.name));
    rows.slice(16).forEach(row => expect(row).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) }));
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 24 }));
  });

  it('AC-11: logs exactly one warning with the counts and no provider error text', async () => {
    const f = bigFile();
    const contents = bigContents();
    const warning = vi.spyOn(Logger.prototype, 'warn'); warning.mockClear();
    const doomed = new Set([contents[2], contents[7]]);
    f.embeddings.embedBatch.mockImplementation((batch: string[]) =>
      (batch[0] === contents[0] ? Promise.reject(new Error('provider exploded (secret)')) : f.fake.embedBatch(batch)));
    f.embeddings.embed.mockImplementation((content: string) =>
      (doomed.has(content) ? Promise.reject(new Error(`provider exploded on ${content}`)) : f.fake.embed(content)));
    await f.indexer.indexRepo('r1', now);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('Knowledge file embedding failed for 2 of 40 chunks (repo r1); storing unembedded chunks');
    expect(String(warning.mock.calls[0][0])).not.toContain('provider exploded');
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 2 }));
  });

  it('AC-12: logs no warning and records no unembedded chunks when every batch succeeds', async () => {
    const f = bigFile();
    const warning = vi.spyOn(Logger.prototype, 'warn'); warning.mockClear();
    await f.indexer.indexRepo('r1', now);
    expect(f.embeddings.embedBatch).toHaveBeenCalledTimes(3);
    expect(f.embeddings.embed).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(f.state.upsertFile).toHaveBeenCalledWith(expect.objectContaining({ unembeddedCount: 0 }));
    expect(f.store.replaceFile).toHaveBeenCalledTimes(1);
  });
});

/**
 * US-002: the pass selects with the project's saved patterns and records the key of the list it read, so a save
 * that lands while a pass runs leaves that pass on the old key and makes the next pass re-select.
 */
describe('KnowledgeRepoIndexer project patterns (US-002)', () => {
  it('AC-8: reads only the files the saved patterns select', async () => {
    const f = fixture(['handbook/a.md', 'docs/b.md']);
    f.state.findProjectPatterns.mockResolvedValue(['handbook/*.md']);

    await f.indexer.indexRepo('r1', now);

    expect(f.state.findProjectPatterns).toHaveBeenCalledWith('p1');
    expect(f.github.getFile.mock.calls).toEqual([['secret', 'o', 'n', 'handbook/a.md', 'head']]);
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ indexedSha: 'head' }));
  });

  it('AC-9: a stored key other than the project list re-selects instead of answering unchanged', async () => {
    const f = fixture(['handbook/a.md']);
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', patternsKey: 'default', fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0 }]);
    f.state.listFiles.mockResolvedValue([stored('handbook/a.md')]);
    f.state.findProjectPatterns.mockResolvedValue(['handbook/*.md']);

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    expect(f.github.getTree).toHaveBeenCalled();
  });

  it('AC-9: an equal key with the same head still answers unchanged', async () => {
    const f = fixture(['handbook/a.md']);
    f.state.listStates.mockResolvedValue([{ repoId: 'r1', indexedSha: 'head', patternsKey: 'handbook/*.md', fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0 }]);
    f.state.listFiles.mockResolvedValue([stored('handbook/a.md')]);
    f.state.findProjectPatterns.mockResolvedValue(['handbook/*.md']);

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'unchanged' });

    expect(f.github.getTree).not.toHaveBeenCalled();
  });

  it('AC-10: records the saved list as the pass key', async () => {
    const f = fixture();
    f.state.findProjectPatterns.mockResolvedValue(['handbook/*.md']);

    await f.indexer.indexRepo('r1', now);

    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', patternsKey: 'handbook/*.md' }));
  });

  it('AC-10: records the default key for a project with no saved list', async () => {
    const f = fixture();

    await f.indexer.indexRepo('r1', now);

    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', patternsKey: 'default' }));
  });

  it('a save during a running pass leaves that pass on the old key and the next pass re-selects', async () => {
    const f = fixture(['handbook/a.md', 'docs/b.md']);
    let saved: string[] | null = ['handbook/*.md'];
    f.state.findProjectPatterns.mockImplementation(async () => saved);
    // The admin's save lands once the pass is already reading files, i.e. after it read the list.
    f.github.getFile.mockImplementation(async (_token: string, _owner: string, _name: string, path: string) => {
      saved = ['docs/*.md'];
      return { content: Buffer.from(text), sha: `blob-${path}`, size: text.length };
    });

    await f.indexer.indexRepo('r1', now);

    expect(f.github.getFile.mock.calls.map(call => call[3])).toEqual(['handbook/a.md']);
    const first = f.state.finish.mock.calls[0][1] as { patternsKey?: string | null };
    expect(first.patternsKey).toBe('handbook/*.md');

    // The next pass reads the key the first pass stored and the newly saved list: they differ, so it re-selects.
    f.state.listStates.mockResolvedValue([{
      repoId: 'r1', indexedSha: 'head', patternsKey: first.patternsKey, fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0,
    }]);
    f.state.listFiles.mockResolvedValue([stored('handbook/a.md')]);
    f.github.getFile.mockClear();

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    expect(f.github.getTree).toHaveBeenCalledTimes(2);
    expect(f.github.getFile.mock.calls.map(call => call[3])).toEqual(['docs/b.md']);
    expect(f.state.finish.mock.calls[1][1]).toMatchObject({ patternsKey: 'docs/*.md' });
  });

  it('an empty saved list selects nothing at all', async () => {
    const f = fixture(['README.md', 'docs/a.md']);
    f.state.findProjectPatterns.mockResolvedValue([]);

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    expect(f.github.getFile).not.toHaveBeenCalled();
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ fileCount: 0, patternsKey: '' }));
  });
});

/**
 * US-004: a GitLab repo is indexed through its read token — one `call` per forge request — with no GitHub method in
 * the pass, the same unchanged-head/truncated-tree/size checks, and a refused token that marks the read token invalid
 * before the pass finishes.
 */
describe('KnowledgeRepoIndexer GitLab passes (US-004)', () => {
  const oversize = (path: string) => ({
    content: Buffer.from('x'.repeat(MAX_KNOWLEDGE_FILE_BYTES + 1)), sha: `blob-${path}`, size: MAX_KNOWLEDGE_FILE_BYTES + 1,
  });

  it('AC-5: a GitLab repo without a credential row is skipped as no credentials, claiming nothing', async () => {
    const f = fixture([], text, { gitlab: true, gitlabConnected: false });

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'skipped', reason: 'no credentials' });

    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'skipped', lastError: 'no credentials' }));
    expect(f.state.claim).not.toHaveBeenCalled();
    Object.values(f.github).forEach(fn => expect(fn).not.toHaveBeenCalled());
    Object.values(f.gitlabChecker).forEach(fn => expect(fn).not.toHaveBeenCalled());
  });

  it('AC-6: a GitHub repo without an installation is skipped as no installation', async () => {
    const f = fixture();
    f.state.findRepo.mockResolvedValue({ ...f.repo, githubInstallationId: null });

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'skipped', reason: 'no installation' });

    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'skipped', lastError: 'no installation' }));
    expect(f.state.claim).not.toHaveBeenCalled();
  });

  it('AC-7: reads head, tree and each kept file through one read call each, then writes their chunks', async () => {
    const f = fixture(['README.md', 'docs/a.md', 'src/a.ts'], text, { gitlab: true });
    const call = vi.spyOn(f.credentials, 'call');

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    expect(f.state.claim).toHaveBeenCalledWith('r1', 'p1', now, 900_000);
    // One `call` per forge request, and every one of them for the read token.
    expect(call.mock.calls.map(argv => [argv[1], argv[0]])).toEqual([
      ['read', f.repo], ['read', f.repo], ['read', f.repo], ['read', f.repo],
    ]);
    const [headAccess, ...restHead] = f.gitlabChecker.getBranchHead.mock.calls[0];
    const [treeAccess, ...restTree] = f.gitlabChecker.getTree.mock.calls[0];
    const fileCalls = f.gitlabChecker.getFile.mock.calls;
    expect(restHead).toEqual(['main']);
    expect(restTree).toEqual(['gl-head']);
    expect(fileCalls.map(argv => argv.slice(1))).toEqual([
      ['README.md', 'gl-head'], ['docs/a.md', 'gl-head'],
    ]);
    // Every request is handed its own access, and each of them is the read token's.
    const accesses = [headAccess, treeAccess, ...fileCalls.map(argv => argv[0])];
    expect(new Set(accesses).size).toBe(accesses.length);
    accesses.forEach(access => expect(access).toEqual({
      token: GITLAB_READ_TOKEN, target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 42 },
    }));
    expect(f.store.replaceFile.mock.calls.map(argv => argv[1])).toEqual(['repo:r1:README.md', 'repo:r1:docs/a.md']);
    f.store.replaceFile.mock.calls.forEach(([, source, rows]) => {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ source: 'repo', source_id: source });
    });
  });

  it('AC-8: a GitLab pass calls no GitHubAppClient method', async () => {
    const f = fixture(['README.md'], text, { gitlab: true });

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    Object.entries(f.github).forEach(([name, fn]) => expect(fn, name).not.toHaveBeenCalled());
  });

  it('AC-9: an unchanged GitLab head answers unchanged without reading the tree or a file', async () => {
    const f = fixture(undefined, text, { gitlab: true });
    f.state.listStates.mockResolvedValue([{
      repoId: 'r1', indexedSha: 'gl-head', patternsKey: 'default', fileCount: 1, chunkCount: 3, unembeddedCount: 0, skippedCount: 0,
    }]);
    f.state.listFiles.mockResolvedValue([stored('docs/a.md')]);

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'unchanged' });

    expect(f.gitlabChecker.getTree).not.toHaveBeenCalled();
    expect(f.gitlabChecker.getFile).not.toHaveBeenCalled();
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', lastError: null, patternsKey: 'default' }));
    // The stored head is the one this pass read, so `finish` keeps it rather than writing it again.
    expect(f.state.finish.mock.calls[0][1]).not.toHaveProperty('indexedSha');
  });

  it('AC-10: a truncated GitLab tree fails the pass without writing chunks', async () => {
    const f = fixture(undefined, text, { gitlab: true });
    f.gitlabChecker.getTree.mockResolvedValue({ entries: [], truncated: true });

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'tree truncated' });

    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'failed', lastError: 'tree truncated', leaseUntil: null }));
    expect(f.store.replaceFile).not.toHaveBeenCalled();
    expect(f.gitlabChecker.getFile).not.toHaveBeenCalled();
  });

  it('AC-11: a fetched file above the byte cap is skipped and counted, and the other kept files are indexed', async () => {
    const f = fixture(['docs/big.md', 'docs/a.md'], text, { gitlab: true });
    f.gitlabChecker.getFile.mockImplementation(async (_access, path: string) =>
      (path === 'docs/big.md' ? oversize(path) : { content: Buffer.from(text), sha: `blob-${path}`, size: text.length }));

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    // The tree entry carries no size, so the file is read and only then skipped.
    expect(f.gitlabChecker.getFile.mock.calls.map(argv => argv[1])).toEqual(['docs/big.md', 'docs/a.md']);
    expect(f.store.replaceFile.mock.calls.map(argv => argv[1])).toEqual(['repo:r1:docs/a.md']);
    expect(f.state.upsertFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: 'docs/a.md' }));
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'idle', skippedCount: 1, fileCount: 1 }));
  });

  it('AC-12: an oversized GitLab file that had rows has its chunks then its row deleted, in that order', async () => {
    const f = fixture(['docs/big.md'], text, { gitlab: true });
    f.state.listFiles.mockResolvedValue([{ repoId: 'r1', path: 'docs/big.md', blobSha: 'old-sha', chunkCount: 3, unembeddedCount: 0 }]);
    f.gitlabChecker.getFile.mockImplementation(async (_access, path: string) => oversize(path));

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'indexed' });

    expect(f.store.deleteFile).toHaveBeenCalledExactlyOnceWith('p1', 'repo:r1:docs/big.md');
    expect(f.state.deleteFile).toHaveBeenCalledExactlyOnceWith('r1', 'docs/big.md');
    expect(f.store.deleteFile.mock.invocationCallOrder[0]).toBeLessThan(f.state.deleteFile.mock.invocationCallOrder[0]);
    // The deletion is fenced by the lease exactly as the GitHub missing-file branch is.
    expect(f.store.deleteFile.mock.invocationCallOrder[0]).toBeLessThan(f.state.renew.mock.invocationCallOrder[0]);
    expect(f.state.renew.mock.invocationCallOrder[0]).toBeLessThan(f.state.deleteFile.mock.invocationCallOrder[0]);
    expect(f.store.replaceFile).not.toHaveBeenCalled();
    expect(f.state.upsertFile).not.toHaveBeenCalled();
  });

  it('AC-13: a refused read token marks the read token invalid before the pass finishes failed', async () => {
    const f = fixture(undefined, text, { gitlab: true });
    f.gitlabChecker.getBranchHead.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
    const order: string[] = [];
    f.markInvalid.mockImplementation(async () => { order.push('mark invalid'); });
    f.state.finish.mockImplementation(async () => { order.push('finish'); });

    expect(await f.indexer.indexRepo('r1', now)).toEqual({ status: 'failed', reason: 'gitlab_token_invalid' });

    expect(f.markInvalid).toHaveBeenCalledExactlyOnceWith('r1', 'read', expect.any(Date));
    expect(order).toEqual(['mark invalid', 'finish']);
    expect(f.state.finish).toHaveBeenCalledWith('r1', expect.objectContaining({ status: 'failed', lastError: 'gitlab_token_invalid' }));
    expect(f.state.finish.mock.calls[0][1]).not.toHaveProperty('indexedSha');
  });
});

/**
 * Fleet S5b US-004 (3c-2-D6/D7): the outcome pass projects one job's latest ingested run outcomes into the
 * project's knowledge table — one file per kind, embedded through the same sequential path a repository file
 * uses, whatever the repository host, with no `KnowledgeRepoIndex`/`KnowledgeRepoFile` state of its own.
 */
describe('KnowledgeRepoIndexer outcome passes (S5b US-004)', () => {
  const JOB = 'j1';
  const reportText = `## Alpha\n${'a'.repeat(500)}\n\n## Beta\n${'b'.repeat(500)}`;
  const decisionsText = '{"id":"D-1"}\n{"id":"D-2"}';
  const report: RunOutcomeRow = { kind: 'report', content: reportText };
  const decisions: RunOutcomeRow = { kind: 'decisions', content: decisionsText };

  /** Only `findRunOutcomes` exists on the state stub: any other state call is a bug the pass must not make. */
  function outcomeFixture(outcomes: RunOutcomeRow[] | null) {
    const job = { id: JOB, projectId: 'p1', repoId: 'r1', owner: 'o', name: 'n', feature: 'f', resultSha: 'abc1234' };
    const state = { findRunOutcomes: vi.fn().mockResolvedValue(outcomes === null ? null : { job, outcomes }) };
    const store = { replaceFile: vi.fn().mockResolvedValue(undefined), deleteFile: vi.fn().mockResolvedValue(undefined) };
    const fake = new FakeEmbeddingProvider();
    const embeddings = {
      dimensions: fake.dimensions, providerName: fake.name, modelName: 'fake-model',
      embedBatch: vi.fn((contents: string[]) => fake.embedBatch(contents)),
      embed: vi.fn((content: string) => fake.embed(content)),
    };
    const rag = { optimizeTable: vi.fn().mockResolvedValue(undefined) };
    const github = {
      mintReadOnlyToken: vi.fn(), getBranchHead: vi.fn(), getTree: vi.fn(), getFile: vi.fn(),
    };
    const indexer = new KnowledgeRepoIndexer(state as unknown as IKnowledgeIndexRepository, github as unknown as GitHubAppClient,
      store as unknown as KnowledgeChunkStore, embeddings as unknown as EmbeddingService, rag as unknown as RagService, mockAuditRecorder,
      {} as unknown as GitLabRepoCredentials, {} as unknown as GitLabAccessChecker, () => now.getTime());
    return { indexer, state, store, embeddings, rag, github, job, fake };
  }

  type OutcomeFixture = ReturnType<typeof outcomeFixture>;
  const written = (f: OutcomeFixture): Array<[string, string, LanceRecord[]]> => f.store.replaceFile.mock.calls as Array<[string, string, LanceRecord[]]>;
  const rowsOf = (f: OutcomeFixture, call = 0): LanceRecord[] => written(f)[call][2];

  it('AC-1: writes one outcome file per kind, report first', async () => {
    const f = outcomeFixture([decisions, report]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    expect(f.state.findRunOutcomes).toHaveBeenCalledWith(JOB);
    expect(written(f).map(call => [call[0], call[1]])).toEqual([
      ['p1', `outcome:r1:${JOB}:report`], ['p1', `outcome:r1:${JOB}:decisions`],
    ]);
    written(f).forEach(([, sourceId, rows]) => {
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row, index) => expect(row).toMatchObject({ source: 'outcome', source_id: sourceId, id: `${sourceId}#${index}` }));
    });
  });

  it('AC-2: decisions rows carry the chunker anchors, the decisions kind and the jsonl path', async () => {
    const f = outcomeFixture([decisions]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    const rows = rowsOf(f);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => JSON.parse(row.metadata))).toEqual([
      expect.objectContaining({ anchor: 'd-1', outcomeKind: 'decisions', path: 'decisions.jsonl' }),
      expect.objectContaining({ anchor: 'd-2', outcomeKind: 'decisions', path: 'decisions.jsonl' }),
    ]);
  });

  it('AC-3: report rows carry the job context, the feature and the report metadata', async () => {
    const f = outcomeFixture([report]);
    const chunks = chunkMarkdown({ path: 'feature-report.md', text: reportText });

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    const rows = rowsOf(f);
    expect(rows).toHaveLength(chunks.length);
    expect(rows[0].content.startsWith(`o/n · run ${JOB} · f · feature-report.md`)).toBe(true);
    rows.forEach((row, index) => {
      expect(JSON.parse(row.metadata)).toEqual({
        repoId: 'r1', owner: 'o', name: 'n', path: 'feature-report.md', sha: 'abc1234', blobSha: '',
        jobId: JOB, feature: 'f', outcomeKind: 'report', chunkCount: chunks.length, ...chunks[index],
      });
      expect(row.content).toBe(`o/n · run ${JOB} · f · feature-report.md${chunks[index].headingPath ? ` · ${chunks[index].headingPath}` : ''}\n${chunks[index].abstract}\n\n${chunks[index].text}`);
      expect(row).toMatchObject({ created_at: now.toISOString(), provider: f.embeddings.providerName, model: 'fake-model' });
    });
    expect(f.embeddings.embedBatch).toHaveBeenCalledWith(rows.map(row => row.content));
  });

  it('AC-4: a job without a decisions outcome deletes its rows and optimizes the table once', async () => {
    const f = outcomeFixture([report]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    expect(f.store.deleteFile.mock.calls).toEqual([['p1', `outcome:r1:${JOB}:decisions`]]);
    expect(f.rag.optimizeTable).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('AC-4: a job with no outcomes at all deletes both files', async () => {
    const f = outcomeFixture([]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    expect(f.store.deleteFile.mock.calls).toEqual([['p1', `outcome:r1:${JOB}:report`], ['p1', `outcome:r1:${JOB}:decisions`]]);
    expect(f.store.replaceFile).not.toHaveBeenCalled();
    expect(f.rag.optimizeTable).toHaveBeenCalledExactlyOnceWith('p1');
  });

  it('AC-4: an outcome whose chunk list is empty deletes that file', async () => {
    const f = outcomeFixture([{ kind: 'decisions', content: '' }]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    expect(f.store.deleteFile).toHaveBeenCalledWith('p1', `outcome:r1:${JOB}:decisions`);
    expect(f.store.replaceFile).not.toHaveBeenCalled();
  });

  it('AC-5: stores zero vectors of the configured width when the embedding provider is down', async () => {
    const f = outcomeFixture([report, decisions]);
    f.embeddings.embedBatch.mockRejectedValue(new Error('embedding failed'));
    f.embeddings.embed.mockRejectedValue(new Error('embedding failed'));

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    const reportRows = rowsOf(f, 0);
    const decisionsRows = rowsOf(f, 1);
    expect(reportRows).toHaveLength(chunkMarkdown({ path: 'feature-report.md', text: reportText }).length);
    expect(decisionsRows).toHaveLength(2);
    [...reportRows, ...decisionsRows].forEach(row => expect(row).toMatchObject({ provider: 'none', model: '', vector: Array(f.embeddings.dimensions).fill(0) }));
  });

  it('AC-6: an unknown job writes nothing', async () => {
    const f = outcomeFixture(null);

    expect(await f.indexer.indexOutcomes('unknown', now)).toEqual({ status: 'skipped', reason: 'unknown job' });

    expect(f.store.replaceFile).not.toHaveBeenCalled();
    expect(f.store.deleteFile).not.toHaveBeenCalled();
    expect(f.rag.optimizeTable).not.toHaveBeenCalled();
    expect(f.embeddings.embedBatch).not.toHaveBeenCalled();
  });

  it('AC-7: a failing write fails the pass with the error message', async () => {
    const f = outcomeFixture([report]);
    f.store.replaceFile.mockRejectedValue(new Error('boom'));

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'failed', reason: 'boom' });
  });

  it('AC-7: cuts the failure reason to 500 characters', async () => {
    const f = outcomeFixture([report]);
    f.store.replaceFile.mockRejectedValue(new Error('x'.repeat(600)));

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'failed', reason: 'x'.repeat(500) });
  });

  it('indexes outcomes of a job on any repository host: they are read from Postgres, not the forge', async () => {
    const f = outcomeFixture([report]);

    expect(await f.indexer.indexOutcomes(JOB, now)).toEqual({ status: 'indexed' });

    expect(Object.values(f.github).every(fn => fn.mock.calls.length === 0)).toBe(true);
    expect(f.store.replaceFile).toHaveBeenCalledTimes(1);
  });

  it('never writes repository index state for an outcome pass', async () => {
    const f = outcomeFixture([report, decisions]);

    await f.indexer.indexOutcomes(JOB, now);

    // The stub holds `findRunOutcomes` only: a pass that touched claim/finish/upsertFile would throw instead.
    expect(Object.keys(f.state)).toEqual(['findRunOutcomes']);
    expect(f.store.deleteFile).not.toHaveBeenCalled();
  });
});
