import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import type { IGitLabCredentialRepository } from '../git-broker/prisma-gitlab-credential.repository';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { encryptToken } from '../../common/utils/encryption.util';

const headSha = 'a'.repeat(40);
const repoRef = { id: 'repo', owner: 'acme', name: 'app', githubInstallationId: 42n };
const at = new Date('2026-11-01T00:00:00Z');

/** US-005: the key the GitLab credential store decrypts under; 32 bytes of hex, as the env holds it. */
const GITLAB_KEY = 'a'.repeat(64);
/** US-005: the two tokens differ, so the access a read passes proves which token kind was resolved. */
const GITLAB_READ_TOKEN = 'gitlab-read-token';
const GITLAB_WRITE_TOKEN = 'gitlab-write-token';
/** US-005: the repo a GitLab FIX snapshot reads, with its own host and no GitHub installation. */
const gitlabRepoRef = { id: 'repo', provider: 'gitlab', host: 'https://gitlab.example.com', owner: 'acme', name: 'app', githubInstallationId: null };

function setup() {
  const repo = {
    latestRunForPr: vi.fn(async () => 'latest'),
    pendingForFix: vi.fn(async () => [
      { id: 'r1', itemId: 'D-1', text: 'confirmed: evidence', actorType: 'AGENT', actorId: 'agent-id', actorName: 'rev-bot', createdAt: at },
      { id: 'r2', itemId: 'B3', text: 'waived: scope', actorType: 'USER', actorName: `A\n${'x'.repeat(120)}`, createdAt: at },
      { id: 'r3', itemId: 'S-1', text: 'verified: system', actorType: 'SYSTEM', actorId: 'flow', actorName: 'flow', createdAt: at },
    ]),
  };
  const github = { mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral' })), getPullRequest: vi.fn(async (): Promise<unknown> => ({ state: 'open', headSha })) };
  // US-005: the production credential store over an in-memory row, so `call` and its invalid mark are real.
  const markInvalid = vi.fn(async () => undefined);
  const credentialRow = {
    repoId: 'repo', gitlabProjectId: 7,
    encryptedReadToken: encryptToken(GITLAB_READ_TOKEN, GITLAB_KEY), encryptedWriteToken: encryptToken(GITLAB_WRITE_TOKEN, GITLAB_KEY),
    readTokenUserId: 1, readTokenUsername: 'reader', writeTokenUserId: 2, writeTokenUsername: 'writer', writeTokenIsBot: true,
    readTokenExpiresAt: null, writeTokenExpiresAt: null, readTokenInvalidAt: null, writeTokenInvalidAt: null,
  };
  const credentials = new GitLabRepoCredentials(
    { findByRepoId: vi.fn(async () => credentialRow), markInvalid, upsert: vi.fn() } as unknown as IGitLabCredentialRepository,
    { encryptionKey: GITLAB_KEY },
  );
  const gitlab = { getMergeRequest: vi.fn(async (): Promise<unknown> => ({ state: 'open', headSha: 'h1' })) };
  const service = new FleetPrRulingsService(repo as never, {} as never, {} as never, {} as never, github as never, {} as never,
    credentials, gitlab as never);
  return { service, repo, github, credentials, gitlab, markInvalid };
}

/** US-005: the access a GitLab read presents: the read token and the repo's own host and project id. */
const gitlabAccess = { token: GITLAB_READ_TOKEN, target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 7 } };

describe('FIX ruling snapshot', () => {
  it('AC-2/3/7/8 selects only the latest RUN, maps both actors and sanitizes labels', async () => {
    const { service, repo, github } = setup();
    const result = await service.snapshotForFix(repoRef as never, 42);
    expect(repo.latestRunForPr).toHaveBeenCalledWith('repo', 42);
    expect(repo.pendingForFix).toHaveBeenCalledExactlyOnceWith('latest');
    expect(result).toEqual({ headSha, rulings: [
      { rulingId: 'r1', item: 'D-1', ruling: 'confirmed: evidence', by: 'koda:agent:rev-bot', at: at.toISOString() },
      { rulingId: 'r2', item: 'B3', ruling: 'waived: scope', by: `koda:user:A${'x'.repeat(89)}`, at: at.toISOString() },
      { rulingId: 'r3', item: 'S-1', ruling: 'verified: system', by: 'koda:system:flow', at: at.toISOString() },
    ] });
    expect(github.mintThreadReadToken).toHaveBeenCalledExactlyOnceWith(42n, 'app');
    expect(github.getPullRequest).toHaveBeenCalledExactlyOnceWith('ephemeral', 'acme', 'app', 42);
  });
  it('caps the snapshot at the oldest 100 even if a repository returns more', async () => {
    const { service, repo } = setup();
    repo.pendingForFix.mockResolvedValue(Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, itemId: `D-${i}`, text: 'verified', actorType: 'AGENT', actorName: 'rev-bot', createdAt: new Date((100 - i) * 1000) })));
    const result = await service.snapshotForFix(repoRef as never, 42);
    expect(result && 'rulings' in result && result.rulings.map((r) => r.item)).toEqual(Array.from({ length: 100 }, (_, i) => `D-${100 - i}`));
  });
  it('AC-4 does not read GitHub when none are pending', async () => {
    const { service, repo, github } = setup(); repo.pendingForFix.mockResolvedValue([]);
    expect(await service.snapshotForFix(repoRef as never, 42)).toBeUndefined();
    expect(github.mintThreadReadToken).not.toHaveBeenCalled();
  });
  it('no RUN means no snapshot', async () => {
    const { service, repo } = setup(); repo.latestRunForPr.mockResolvedValue(null as never);
    expect(await service.snapshotForFix(repoRef as never, 42)).toBeUndefined();
    expect(repo.pendingForFix).not.toHaveBeenCalled();
  });
  it('AC-6 SYSTEM ruling with a failed head read remains non-fatal', async () => {
    const { service, repo, github } = setup();
    repo.pendingForFix.mockResolvedValue([{ id: 'r3', itemId: 'S-1', text: 'verified: system', actorType: 'SYSTEM', actorId: 'flow', actorName: 'flow', createdAt: at }]);
    github.getPullRequest.mockRejectedValue(new Error('forge unavailable'));
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'head-unreadable' });
  });

  it('AC-5 thrown reads are accepted as unreadable', async () => {
    const { service, github } = setup(); github.getPullRequest.mockRejectedValue(new Error('provider failure'));
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'head-unreadable' });
  });
  it.each([{ state: 'closed', headSha }, null])('AC-6/14 closed or missing PR: %j', async (pr) => {
    const { service, github } = setup(); github.getPullRequest.mockResolvedValue(pr);
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'pr-not-open' });
  });
  it('an open PR without its head is unreadable', async () => {
    const { service, github } = setup(); github.getPullRequest.mockResolvedValue({ state: 'open' });
    expect(await service.snapshotForFix(repoRef as never, 42)).toEqual({ notSent: 'head-unreadable' });
  });
});

describe('FIX ruling snapshot on a GitLab merge request', () => {
  it('AC-7: reads the MR with the supplied read access and answers its head and pending rulings', async () => {
    const { service, repo, credentials, gitlab } = setup();
    const call = vi.spyOn(credentials, 'call');
    try {
      const result = await service.snapshotForFix(gitlabRepoRef as never, 12);
      expect(repo.latestRunForPr).toHaveBeenCalledWith('repo', 12);
      expect(result).toEqual({ headSha: 'h1', rulings: [
        { rulingId: 'r1', item: 'D-1', ruling: 'confirmed: evidence', by: 'koda:agent:rev-bot', at: at.toISOString() },
        { rulingId: 'r2', item: 'B3', ruling: 'waived: scope', by: `koda:user:A${'x'.repeat(89)}`, at: at.toISOString() },
        { rulingId: 'r3', item: 'S-1', ruling: 'verified: system', by: 'koda:system:flow', at: at.toISOString() },
      ] });
      // The access the checker receives is exactly the one `call` was handed, and it is a read token.
      expect(gitlab.getMergeRequest).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
      expect(call.mock.calls.map((args) => args[1])).toEqual(['read']);
      expect(call.mock.calls[0][0]).toMatchObject({ id: 'repo', host: 'https://gitlab.example.com' });
    } finally { call.mockRestore(); }
  });

  it.each([null, { state: 'closed', headSha: 'h1' }])('AC-8: a missing or closed MR answers pr-not-open: %j', async (mr) => {
    const { service, gitlab } = setup();
    gitlab.getMergeRequest.mockResolvedValue(mr as never);
    expect(await service.snapshotForFix(gitlabRepoRef as never, 12)).toEqual({ notSent: 'pr-not-open' });
  });

  it('AC-9: an open MR without a head is unreadable', async () => {
    const { service, gitlab } = setup();
    gitlab.getMergeRequest.mockResolvedValue({ state: 'open' });
    expect(await service.snapshotForFix(gitlabRepoRef as never, 12)).toEqual({ notSent: 'head-unreadable' });
    expect(gitlab.getMergeRequest).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
  });

  it('AC-9: a thrown credentials or provider error is unreadable', async () => {
    const { service, gitlab } = setup();
    gitlab.getMergeRequest.mockRejectedValue(new RepoCheckException('provider_error'));
    expect(await service.snapshotForFix(gitlabRepoRef as never, 12)).toEqual({ notSent: 'head-unreadable' });
    expect(gitlab.getMergeRequest).toHaveBeenCalledExactlyOnceWith(gitlabAccess, 12);
  });

  it('AC-14: a GitHub repo mints a thread-read token and never touches the GitLab store', async () => {
    const { service, credentials, gitlab } = setup();
    const call = vi.spyOn(credentials, 'call');
    try {
      await expect(service.snapshotForFix(repoRef as never, 42)).resolves.toMatchObject({ headSha });
      expect(call).not.toHaveBeenCalled();
      expect(gitlab.getMergeRequest).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });

  it('AC-15: a 401 MR read marks the read token invalid before answering head-unreadable', async () => {
    const { service, gitlab, markInvalid } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    markInvalid.mockImplementation(async () => { await gate; });
    // The checker turns a 401 into this refusal; `call` is what marks the token invalid.
    gitlab.getMergeRequest.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
    let settled = false;
    const answer = service.snapshotForFix(gitlabRepoRef as never, 12).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(markInvalid).toHaveBeenCalledExactlyOnceWith('repo', 'read', expect.any(Date));
    expect(settled).toBe(false);
    release();
    await expect(answer).resolves.toEqual({ notSent: 'head-unreadable' });
  });
});

it('AC-1 GitHub getPullRequest maps head.sha without a socket', async () => {
  const http = { request: vi.fn(async () => ({ status: 200, body: { state: 'open', html_url: 'https://github.com/acme/app/pull/42', head: { sha: headSha } } })) };
  const client = new GitHubAppClient({} as never, { githubApiUrl: 'https://api.github.com' } as never, http as never, {} as never);
  expect(await client.getPullRequest('ephemeral', 'acme', 'app', 42)).toMatchObject({ headSha });
});
