import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, forgeCall, toNaxEntries } from './fleet-repo-files.reader';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';
import { FleetRepoFilesRouter } from './fleet-repo-files.router';
import { ForgeErrorException, NaxFileUnreadableException, RepoUnreachableException } from './repo-config.exceptions';

const GH: FleetRepoRef = { id: 'repo-1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) };
const GL: FleetRepoRef = { ...GH, id: 'repo-2', provider: 'gitlab', owner: 'grp/sub', githubInstallationId: null };

describe('toNaxEntries', () => {
  it('keeps allowlisted blobs only, sorted by group then path', () => {
    const out = toNaxEntries([
      { path: '.nax/status.json', type: 'blob', sha: 'x', size: 1 },
      { path: '.nax/profiles/fast.env', type: 'blob', sha: 'x', size: 1 },
      { path: '.nax/rules', type: 'tree', sha: 'x', size: null },
      { path: '.nax/config.json', type: 'blob', sha: 'c', size: 3 },
      { path: '.nax/rules/z.md', type: 'blob', sha: 'z', size: 4 },
      { path: '.nax/rules/a.md', type: 'blob', sha: 'a', size: 5 },
      { path: '.nax/context.md', type: 'blob', sha: 'k', size: null },
    ]);
    expect(out).toEqual([
      { path: '.nax/rules/a.md', size: 5, blobSha: 'a', group: 'rules' },
      { path: '.nax/rules/z.md', size: 4, blobSha: 'z', group: 'rules' },
      { path: '.nax/context.md', size: null, blobSha: 'k', group: 'context' },
      { path: '.nax/config.json', size: 3, blobSha: 'c', group: 'config' },
    ]);
  });
});

describe('decodeNaxFile', () => {
  it('decodes UTF-8 text', () => {
    expect(decodeNaxFile('.nax/context.md', { sha: 's', size: 3, content: Buffer.from('hé') })).toEqual({ path: '.nax/context.md', blobSha: 's', content: 'hé' });
  });
  it.each([
    ['too_large', { sha: 's', size: 262_145, content: Buffer.alloc(262_145, 97) }],
    ['not_text', { sha: 's', size: 2, content: Buffer.from([0xff, 0xfe]) }],
    ['not_text', { sha: 's', size: 3, content: Buffer.from('a\u0000b') }],
  ])('refuses %s', (reason, file) => {
    expect(() => decodeNaxFile('.nax/context.md', file)).toThrow(NaxFileUnreadableException);
    try { decodeNaxFile('.nax/context.md', file); } catch (e) { expect((e as NaxFileUnreadableException).reason).toBe(reason); }
  });
});

describe('forgeCall', () => {
  it.each(['vcs_connection_missing', 'vcs_connection_mismatch', 'vcs_encryption_key_missing', 'app_not_installed', 'github_app_not_configured', 'gitlab_token_invalid', 'repo_not_found'])(
    'maps %s to 409 repo_unreachable', async (reason) => {
      await expect(forgeCall(async () => { throw new RepoCheckException(reason as never); })).rejects.toBeInstanceOf(RepoUnreachableException);
    });
  it.each(['provider_error', 'provider_unreachable'])('maps %s to 502', async (reason) => {
    await expect(forgeCall(async () => { throw new RepoCheckException(reason as never); })).rejects.toBeInstanceOf(ForgeErrorException);
  });
  it('passes other errors through', async () => {
    const boom = new Error('boom');
    await expect(forgeCall(async () => { throw boom; })).rejects.toBe(boom);
  });
});

describe('GithubFleetRepoFilesReader', () => {
  const github = {
    mintInstallationToken: vi.fn(async () => ({ token: 'ghs_t', expiresAt: new Date() })),
    getBranchHead: vi.fn(async () => 'c0ffee1'),
    getTree: vi.fn(async (_t: string, _o: string, _n: string, treeish: string) => treeish === 'c0ffee1'
      ? { truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'naxTree', size: null }, { path: 'src', type: 'tree', sha: 'x', size: null }] }
      : { truncated: false, entries: [{ path: 'context.md', type: 'blob', sha: 'k', size: 9 }, { path: 'features/x/prd.json', type: 'blob', sha: 'f', size: 1 }] }),
    getFile: vi.fn(async () => ({ sha: 'k', size: 2, content: Buffer.from('hi') })),
  };
  const reader = new GithubFleetRepoFilesReader(github as never);
  afterEach(() => vi.clearAllMocks());

  it('lists .nax from the default-branch head with one mint', async () => {
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [{ path: '.nax/context.md', size: 9, blobSha: 'k', group: 'context' }] });
    expect(github.mintInstallationToken).toHaveBeenCalledTimes(1);
    expect(github.mintInstallationToken).toHaveBeenCalledWith(BigInt(77), 'app');
    expect(github.getTree).toHaveBeenLastCalledWith('ghs_t', 'acme', 'app', 'naxTree', true);
  });

  it('returns no files when the repo has no .nax dir', async () => {
    github.getTree.mockResolvedValueOnce({ truncated: false, entries: [] });
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [] });
  });

  it('refuses a truncated .nax tree (502) and a repo without an installation (409)', async () => {
    github.getTree.mockResolvedValueOnce({ truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'n', size: null }] })
      .mockResolvedValueOnce({ truncated: true, entries: [] });
    await expect(reader.list(GH)).rejects.toBeInstanceOf(ForgeErrorException);
    await expect(reader.list({ ...GH, githubInstallationId: null })).rejects.toBeInstanceOf(RepoUnreachableException);
  });

  it('reads one file at a ref; a missing file is 404', async () => {
    await expect(reader.read(GH, '.nax/context.md', 'c0ffee1')).resolves.toEqual({ path: '.nax/context.md', blobSha: 'k', content: 'hi' });
    expect(github.getFile).toHaveBeenCalledWith('ghs_t', 'acme', 'app', '.nax/context.md', 'c0ffee1');
    github.getFile.mockResolvedValueOnce(null);
    await expect(reader.read(GH, '.nax/context.md', 'c0ffee1')).rejects.toMatchObject({ status: 404 });
  });

  it('leaves out files whose names fall outside the allowlist (spaces, non-ASCII) and lists the rest', async () => {
    github.getTree
      .mockResolvedValueOnce({ truncated: false, entries: [{ path: '.nax', type: 'tree', sha: 'naxTree', size: null }] })
      .mockResolvedValueOnce({ truncated: false, entries: [
        { path: 'rules/my rule.md', type: 'blob', sha: 's1', size: 1 },
        { path: 'rules/规则.md', type: 'blob', sha: 's2', size: 1 },
        { path: 'rules/ok.md', type: 'blob', sha: 's3', size: 1 },
      ] });
    await expect(reader.list(GH)).resolves.toEqual({ baseSha: 'c0ffee1', defaultBranch: 'trunk', files: [{ path: '.nax/rules/ok.md', size: 1, blobSha: 's3', group: 'rules' }] });
  });
});

describe('GitlabFleetRepoFilesReader', () => {
  const gitlab = {
    getBranchHead: vi.fn(async () => 'c1'),
    listTree: vi.fn(async () => [{ path: '.nax/rules/a.md', type: 'blob', sha: 'a', size: null }]),
    getFile: vi.fn(async () => ({ sha: 'a', size: 1, content: Buffer.from('x') })),
  };
  const tokens = { resolve: vi.fn(async () => 'glpat') };
  const reader = new GitlabFleetRepoFilesReader(gitlab as never, tokens as never);

  it('lists with the project token and a null size', async () => {
    await expect(reader.list(GL)).resolves.toEqual({ baseSha: 'c1', defaultBranch: 'trunk', files: [{ path: '.nax/rules/a.md', size: null, blobSha: 'a', group: 'rules' }] });
    expect(tokens.resolve).toHaveBeenCalledWith('p1', 'grp/sub', 'app');
    expect(gitlab.listTree).toHaveBeenCalledWith('glpat', 'grp/sub', 'app', '.nax', 'c1');
  });

  it('maps a missing VcsConnection to 409 repo_unreachable', async () => {
    tokens.resolve.mockRejectedValueOnce(new RepoCheckException('vcs_connection_missing'));
    await expect(reader.list(GL)).rejects.toBeInstanceOf(RepoUnreachableException);
  });
});

describe('FleetRepoFilesRouter', () => {
  it('routes by provider', async () => {
    const gh = { list: vi.fn(async () => 'gh'), read: vi.fn() };
    const gl = { list: vi.fn(async () => 'gl'), read: vi.fn() };
    const router = new FleetRepoFilesRouter(gh as never, gl as never);
    await expect(router.list(GH)).resolves.toBe('gh');
    await expect(router.list(GL)).resolves.toBe('gl');
  });
});
