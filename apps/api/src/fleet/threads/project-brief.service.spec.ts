import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GitHubAppClient } from '../git-broker/github-app-client';
import type { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import type { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { ForgeFile } from '../git-broker/forge-tree';
import type { FleetRepoRecord, IFleetRepoRepository } from '../repos/domain/fleet-repo.domain';
import { ProjectBriefService } from './project-brief.service';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const NEXT_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';
const HEAD7 = HEAD.slice(0, 7);
const CONTEXT_FILE = '.nax/context.md';
const FALLBACK_FILE = 'AGENTS.md';
const UNAVAILABLE = 'Repository context: unavailable';
/** The 300 s cache TTL and the 3000 ms read bound are the two clocks this spec moves. */
const TTL_MS = 300_000;
const TIMEOUT_MS = 3_000;

type GitHubMock = {
  mintInstallationToken: Mock<(installationId: bigint, repoName: string) => Promise<{ token: string; expiresAt: Date }>>;
  getBranchHead: Mock<(token: string, owner: string, name: string, branch: string) => Promise<string>>;
  getFile: Mock<(token: string, owner: string, name: string, path: string, ref: string) => Promise<ForgeFile | null>>;
};

type ReposMock = { findById: Mock<(id: string) => Promise<FleetRepoRecord | null>> };

const repoRecord = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
  id: 'r1',
  projectId: 'p1',
  provider: 'github',
  owner: 'acme',
  name: 'koda',
  defaultBranch: 'main',
  githubInstallationId: BigInt(9),
  createdById: 'u1',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  autoReview: false,
  autoReviewProfiles: [],
  autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: null,
  autoReviewEnabledByType: null,
  autoReviewEnabledAt: null,
  ...over,
});

const forgeFile = (text: string): ForgeFile => ({ sha: 'blob-sha', size: Buffer.byteLength(text), content: Buffer.from(text, 'utf8') });

const header = (path: string, sha: string, cached = false): string =>
  `Repository context (acme/koda ${path} @ ${sha.slice(0, 7)}${cached ? ', cached' : ''}):`;

/** `bytes` bytes of 60-byte ASCII lines (59 characters plus the newline). */
const asciiFile = (bytes: number): string => `${'x'.repeat(59)}\n`.repeat(Math.ceil(bytes / 60)).slice(0, bytes);

describe('ProjectBriefService', () => {
  let clock: number;
  let github: GitHubMock;
  let repos: ReposMock;
  let gitlabCredentials: { call: Mock; resolve: Mock; markInvalid: Mock };
  let gitlabChecker: { getBranchHead: Mock; getFile: Mock };
  let service: ProjectBriefService;

  /** Only `.nax/context.md` exists, holding `text`. */
  const onlyContext = (text: string, sha = HEAD): void => {
    github.getBranchHead.mockResolvedValue(sha);
    github.getFile.mockImplementation(async (_token, _owner, _name, path) => (path === CONTEXT_FILE ? forgeFile(text) : null));
  };

  /** Only `AGENTS.md` exists, holding `text`. */
  const onlyFallback = (text: string): void => {
    github.getBranchHead.mockResolvedValue(HEAD);
    github.getFile.mockImplementation(async (_token, _owner, _name, path) => (path === FALLBACK_FILE ? forgeFile(text) : null));
  };

  beforeEach(() => {
    clock = 0;
    github = {
      mintInstallationToken: vi.fn<(installationId: bigint, repoName: string) => Promise<{ token: string; expiresAt: Date }>>(
        async () => ({ token: 'installation-token', expiresAt: new Date(clock + 3_600_000) }),
      ),
      getBranchHead: vi.fn<(token: string, owner: string, name: string, branch: string) => Promise<string>>(async () => HEAD),
      getFile: vi.fn<(token: string, owner: string, name: string, path: string, ref: string) => Promise<ForgeFile | null>>(async () => null),
    };
    repos = { findById: vi.fn<(id: string) => Promise<FleetRepoRecord | null>>(async () => repoRecord()) };
    gitlabCredentials = {
      resolve: vi.fn(),
      markInvalid: vi.fn(),
      call: vi.fn(async (_repo, _kind, fn) => fn({ token: 'read-token', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 42 } })),
    };
    gitlabChecker = {
      getBranchHead: vi.fn(async () => HEAD),
      getFile: vi.fn(async () => null),
    };
    service = new ProjectBriefService(
      github as unknown as GitHubAppClient,
      repos as unknown as IFleetRepoRepository,
      gitlabCredentials as unknown as GitLabRepoCredentials,
      gitlabChecker as unknown as GitLabAccessChecker,
      () => clock,
    );
  });

  const useGitLab = (): void => {
    repos.findById.mockResolvedValue(repoRecord({ provider: 'gitlab', githubInstallationId: null }));
    gitlabChecker.getBranchHead.mockResolvedValue('abcdef1234');
    gitlabChecker.getFile.mockImplementation(async (_access, path) => path === CONTEXT_FILE ? forgeFile('hello') : null);
  };

  it('US-003 AC-1/2: reads a GitLab context using a separate read call per request', async () => {
    useGitLab();
    const accessA = { token: 'a', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 42 } };
    const accessB = { token: 'b', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 42 } };
    gitlabCredentials.call.mockImplementationOnce(async (_repo, kind, fn) => { expect(kind).toBe('read'); return fn(accessA); });
    gitlabCredentials.call.mockImplementationOnce(async (_repo, kind, fn) => { expect(kind).toBe('read'); return fn(accessB); });
    expect(await service.resolveRepoContext('r1')).toBe('Repository context (acme/koda .nax/context.md @ abcdef1):\nhello');
    expect(gitlabChecker.getBranchHead).toHaveBeenCalledWith(accessA, 'main');
    expect(gitlabChecker.getFile).toHaveBeenCalledWith(accessB, CONTEXT_FILE, 'abcdef1234');
    expect(gitlabCredentials.call).toHaveBeenCalledTimes(2);
    expect(gitlabCredentials.call).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'r1' }), 'read', expect.any(Function));
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
    expect(github.getBranchHead).not.toHaveBeenCalled();
    expect(github.getFile).not.toHaveBeenCalled();
  });

  it('US-003 AC-3: falls back to GitLab AGENTS.md', async () => {
    useGitLab();
    gitlabChecker.getFile.mockImplementation(async (_access, path) => path === FALLBACK_FILE ? forgeFile('agents') : null);
    expect(await service.resolveRepoContext('r1')).toBe('Repository context (acme/koda AGENTS.md @ abcdef1):\nagents');
    expect(gitlabChecker.getFile).toHaveBeenNthCalledWith(2, expect.anything(), FALLBACK_FILE, 'abcdef1234');
  });

  it('US-003 AC-4: missing credentials degrades without a checker call', async () => {
    useGitLab();
    gitlabCredentials.call.mockRejectedValue(new RepoCheckException('gitlab_credentials_missing'));
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no credentials)`);
    expect(gitlabChecker.getBranchHead).not.toHaveBeenCalled();
  });

  it('US-003 AC-5: serves the shared GitLab cache inside its TTL', async () => {
    useGitLab();
    const first = await service.resolveRepoContext('r1');
    clock = TTL_MS - 1;
    expect(await service.resolveRepoContext('r1')).toBe(first);
    expect(gitlabChecker.getBranchHead).toHaveBeenCalledTimes(1);
  });

  it('US-003 AC-6: missing credentials after TTL do not serve stale text', async () => {
    useGitLab();
    await service.resolveRepoContext('r1');
    clock = TTL_MS;
    gitlabCredentials.call.mockRejectedValue(new RepoCheckException('gitlab_credentials_missing'));
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no credentials)`);
  });

  it('US-003 AC-7: other post-TTL failures serve cached text', async () => {
    useGitLab();
    await service.resolveRepoContext('r1');
    clock = TTL_MS;
    gitlabChecker.getBranchHead.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
    expect(await service.resolveRepoContext('r1')).toBe('Repository context (acme/koda .nax/context.md @ abcdef1, cached):\nhello');
  });

  it('US-003 AC-10: credential call invalidates a refused read token before degradation', async () => {
    useGitLab();
    const order: string[] = [];
    gitlabCredentials.markInvalid.mockImplementation(async () => { order.push('invalidated'); });
    gitlabCredentials.call.mockImplementation(async (_repo, kind, fn) => {
      try { return await fn({ token: 'read-token', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 42 } }); }
      catch (error) {
        if (error instanceof RepoCheckException && error.reason === 'gitlab_token_invalid') {
          await gitlabCredentials.markInvalid('r1', kind);
        }
        throw error;
      }
    });
    gitlabChecker.getBranchHead.mockImplementation(async () => { order.push('401'); throw new RepoCheckException('gitlab_token_invalid'); });
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (read failed)`);
    expect(gitlabCredentials.markInvalid).toHaveBeenCalledWith('r1', 'read');
    expect(order).toEqual(['401', 'invalidated']);
  });

  it('US-003 AC-8: a GitLab file failure without cache degrades to read failed', async () => {
    useGitLab();
    gitlabChecker.getFile.mockRejectedValue(new RepoCheckException('provider_error'));
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (read failed)`);
  });

  it('US-003 AC-11: a GitLab timeout serves cached text', async () => {
    vi.useFakeTimers();
    try {
      useGitLab();
      await service.resolveRepoContext('r1');
      clock = TTL_MS;
      gitlabChecker.getBranchHead.mockImplementation(() => new Promise<string>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toContain(', cached):\nhello');
    } finally { vi.useRealTimers(); }
  });

  it('US-003 AC-12: a GitLab timeout without cache degrades to timeout', async () => {
    vi.useFakeTimers();
    try {
      useGitLab();
      gitlabChecker.getBranchHead.mockImplementation(() => new Promise<string>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toBe(`${UNAVAILABLE} (timeout)`);
    } finally { vi.useRealTimers(); }
  });

  it('AC-1: a GitHub repository whose .nax/context.md has text returns the header and the text', async () => {
    onlyContext('# Arch');
    const section = await service.resolveRepoContext('r1');
    expect(section.split('\n')).toEqual([header(CONTEXT_FILE, HEAD), '# Arch']);
    expect(github.mintInstallationToken).toHaveBeenCalledWith(BigInt(9), 'koda');
    expect(github.getBranchHead).toHaveBeenCalledWith('installation-token', 'acme', 'koda', 'main');
    expect(github.getFile).toHaveBeenCalledWith('installation-token', 'acme', 'koda', CONTEXT_FILE, HEAD);
    expect(gitlabCredentials.call).not.toHaveBeenCalled();
    expect(gitlabCredentials.resolve).not.toHaveBeenCalled();
  });

  it('AC-2: a missing .nax/context.md falls back to AGENTS.md', async () => {
    onlyFallback('agents');
    const section = await service.resolveRepoContext('r1');
    expect(section.split('\n')).toEqual([header(FALLBACK_FILE, HEAD), 'agents']);
    expect(github.getFile).toHaveBeenNthCalledWith(1, 'installation-token', 'acme', 'koda', CONTEXT_FILE, HEAD);
    expect(github.getFile).toHaveBeenNthCalledWith(2, 'installation-token', 'acme', 'koda', FALLBACK_FILE, HEAD);
  });

  it('AC-3: a whitespace-only .nax/context.md falls back to AGENTS.md', async () => {
    github.getBranchHead.mockResolvedValue(HEAD);
    github.getFile.mockImplementation(async (_token, _owner, _name, path) => {
      if (path === CONTEXT_FILE) return forgeFile('  \n\t ');
      return path === FALLBACK_FILE ? forgeFile('agents') : null;
    });
    const section = await service.resolveRepoContext('r1');
    expect(section.split('\n')).toEqual([header(FALLBACK_FILE, HEAD), 'agents']);
  });

  it('AC-4: neither context file answers unavailable (no context file)', async () => {
    const section = await service.resolveRepoContext('r1');
    expect(section).toBe(`${UNAVAILABLE} (no context file)`);
    expect(github.getFile).toHaveBeenCalledTimes(2);
  });

  const noContextCases: Array<{ name: string; id: string | null; record: FleetRepoRecord; reason: string }> = [
    { name: 'a null repository id', id: null, record: repoRecord(), reason: 'no repository' },
    { name: 'a GitLab repository', id: 'r1', record: repoRecord({ provider: 'gitlab' }), reason: 'no credentials' },
    { name: 'a GitHub repository without an installation', id: 'r1', record: repoRecord({ githubInstallationId: null }), reason: 'no installation' },
  ];

  for (const { name, id, record, reason } of noContextCases) {
    it(`AC-5: ${name} answers unavailable (${reason}) and calls no GitHub method`, async () => {
      repos.findById.mockResolvedValue(record);
      if (record.provider === 'gitlab') gitlabCredentials.call.mockRejectedValue(new RepoCheckException('gitlab_credentials_missing'));
      expect(await service.resolveRepoContext(id)).toBe(`${UNAVAILABLE} (${reason})`);
      expect(github.mintInstallationToken).not.toHaveBeenCalled();
      expect(github.getBranchHead).not.toHaveBeenCalled();
      expect(github.getFile).not.toHaveBeenCalled();
    });
  }

  it('AC-5: an unknown repository id answers unavailable (no repository)', async () => {
    repos.findById.mockResolvedValue(null);
    expect(await service.resolveRepoContext('nope')).toBe(`${UNAVAILABLE} (no repository)`);
    expect(github.getBranchHead).not.toHaveBeenCalled();
  });

  it('AC-6: a second call 100 seconds on makes no GitHub call', async () => {
    onlyContext('# Arch');
    const first = await service.resolveRepoContext('r1');
    clock = 100_000;
    const second = await service.resolveRepoContext('r1');
    expect(github.getBranchHead).toHaveBeenCalledTimes(1);
    expect(github.getFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('AC-7: a re-check 400 seconds on with an unchanged sha re-reads no file', async () => {
    onlyContext('# Arch');
    const first = await service.resolveRepoContext('r1');
    clock = 400_000;
    const second = await service.resolveRepoContext('r1');
    expect(github.getBranchHead).toHaveBeenCalledTimes(2);
    expect(github.getFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('AC-7: an unchanged sha refreshes checkedAt, so the next call is served from the cache', async () => {
    onlyContext('# Arch');
    await service.resolveRepoContext('r1');
    clock = 400_000;
    await service.resolveRepoContext('r1');
    clock = 500_000;
    await service.resolveRepoContext('r1');
    expect(github.getBranchHead).toHaveBeenCalledTimes(2);
    expect(github.getFile).toHaveBeenCalledTimes(1);
  });

  it('AC-8: a cached negative result with an unchanged sha re-reads no file', async () => {
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no context file)`);
    clock = 400_000;
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no context file)`);
    expect(github.getBranchHead).toHaveBeenCalledTimes(2);
    expect(github.getFile).toHaveBeenCalledTimes(2);
  });

  it('AC-9: a new sha re-reads the file and the header carries the new sha', async () => {
    github.getBranchHead.mockResolvedValueOnce(HEAD).mockResolvedValueOnce(NEXT_HEAD);
    github.getFile.mockImplementation(async (_token, _owner, _name, path, ref) => {
      if (path !== CONTEXT_FILE) return null;
      return forgeFile(ref === HEAD ? '# Arch' : '# Arch v2');
    });
    await service.resolveRepoContext('r1');
    clock = 400_000;
    const section = await service.resolveRepoContext('r1');
    expect(section.split('\n')).toEqual([header(CONTEXT_FILE, NEXT_HEAD), '# Arch v2']);
    expect(github.getFile).toHaveBeenNthCalledWith(2, 'installation-token', 'acme', 'koda', CONTEXT_FILE, NEXT_HEAD);
  });

  it('AC-10: a read that outlives 3000 ms answers unavailable (timeout) and warns once', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      github.getBranchHead.mockImplementation(() => new Promise<string>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toBe(`${UNAVAILABLE} (timeout)`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-11: a failing read with no cache answers unavailable (read failed) and warns once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    github.getBranchHead.mockRejectedValue(new RepoCheckException('provider_error'));
    await expect(service.resolveRepoContext('r1')).resolves.toBe(`${UNAVAILABLE} (read failed)`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
  });

  it('AC-12: a failing re-check serves the cached text with , cached', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    onlyContext('# Arch');
    await service.resolveRepoContext('r1');
    clock = 400_000;
    github.getBranchHead.mockRejectedValue(new RepoCheckException('repo_not_found'));
    const section = await service.resolveRepoContext('r1');
    expect(section).toBe(`Repository context (acme/koda ${CONTEXT_FILE} @ ${HEAD7}, cached):\n# Arch`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
  });

  it('AC-13: a re-check that outlives 3000 ms serves the cached text with , cached', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      onlyContext('# Arch');
      await service.resolveRepoContext('r1');
      clock = 400_000;
      github.getBranchHead.mockImplementation(() => new Promise<string>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toBe(`Repository context (acme/koda ${CONTEXT_FILE} @ ${HEAD7}, cached):\n# Arch`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-14: a 14000-byte context file is capped at 10240 bytes and ends with [truncated]', async () => {
    const text = asciiFile(14_000);
    expect(Buffer.byteLength(text, 'utf8')).toBe(14_000);
    onlyContext(text);
    const section = await service.resolveRepoContext('r1');
    const head = `${header(CONTEXT_FILE, HEAD)}\n`;
    expect(section.startsWith(head)).toBe(true);
    const body = section.slice(head.length);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(10_240);
    expect(body.endsWith('\n[truncated]')).toBe(true);
  });

  it('AC-15: a secret in the context file is masked before the section is returned', async () => {
    onlyContext('DB_PASSWORD=hunter2 x');
    const section = await service.resolveRepoContext('r1');
    expect(section).toContain('DB_PASSWORD=[masked] x');
    expect(section).not.toContain('hunter2');
  });

  it('serves a cached negative result within the TTL without touching GitHub', async () => {
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no context file)`);
    clock = 100_000;
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no context file)`);
    expect(github.getBranchHead).toHaveBeenCalledTimes(1);
    expect(github.getFile).toHaveBeenCalledTimes(2);
  });

  it('treats a whitespace-only AGENTS.md as absent', async () => {
    onlyFallback('  \n\t\n ');
    expect(await service.resolveRepoContext('r1')).toBe(`${UNAVAILABLE} (no context file)`);
    expect(github.getFile).toHaveBeenCalledTimes(2);
  });

  it('caps the cache at 200 entries and evicts the one with the oldest checkedAt', async () => {
    onlyContext('# Arch');
    for (let i = 0; i < 201; i += 1) {
      repos.findById.mockResolvedValue(repoRecord({ id: `r${i}` }));
      clock = i * 1_000;
      await service.resolveRepoContext(`r${i}`);
    }
    expect(github.getBranchHead).toHaveBeenCalledTimes(201);
    repos.findById.mockResolvedValue(repoRecord({ id: 'r0' }));
    await service.resolveRepoContext('r0');
    expect(github.getBranchHead).toHaveBeenCalledTimes(202);
    await service.resolveRepoContext('r200');
    expect(github.getBranchHead).toHaveBeenCalledTimes(202);
  });

  it('fails open when the repository lookup itself throws', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    repos.findById.mockRejectedValue(new Error('db down'));
    await expect(service.resolveRepoContext('r1')).resolves.toBe(`${UNAVAILABLE} (read failed)`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
  });

  it('F1: a repository lookup that outlives 3000 ms answers unavailable (timeout) and warns once', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      repos.findById.mockImplementation(() => new Promise<FleetRepoRecord | null>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toBe(`${UNAVAILABLE} (timeout)`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: the deadline is one 3000 ms budget, not one per stage (lookup + read)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    try {
      let release: (value: FleetRepoRecord | null) => void = () => {};
      repos.findById.mockImplementation(() => new Promise<FleetRepoRecord | null>((resolve) => { release = resolve; }));
      onlyContext('# Arch');
      const pending = service.resolveRepoContext('r1');
      // The lookup costs 2000 ms of the budget; the read then never settles.
      await vi.advanceTimersByTimeAsync(2_000);
      release(repoRecord());
      github.getBranchHead.mockImplementation(() => new Promise<string>(() => {}));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(`${UNAVAILABLE} (timeout)`);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('r1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('F1: a lookup that outlives 3000 ms cannot name the repository, so the cached text is not rendered', async () => {
    vi.useFakeTimers();
    try {
      onlyContext('# Arch');
      await service.resolveRepoContext('r1');
      clock = 400_000;
      repos.findById.mockImplementation(() => new Promise<FleetRepoRecord | null>(() => {}));
      const pending = service.resolveRepoContext('r1');
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await expect(pending).resolves.toBe(`${UNAVAILABLE} (timeout)`);
    } finally {
      vi.useRealTimers();
    }
  });
});
