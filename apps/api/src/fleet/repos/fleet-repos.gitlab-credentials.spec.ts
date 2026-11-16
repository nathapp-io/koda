import { isIP } from 'node:net';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from './fleet-repos.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

/**
 * US-005: the rotation of a repo's GitLab tokens.
 *
 * The forge is stubbed and the host rule is kept strict (the resolver answers with an address
 * inside an allowed subnet), so the cases below pin the rotation's own rules: which token is
 * verified how, what is refused, what is stored, what is audited and what the broker's cache
 * loses.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

describe('FleetReposService — the GitLab credential rotation', () => {
  const repo = { findById: vi.fn() };
  const github = { verifyRepo: vi.fn() };
  const gitlab = { getTokenSelf: vi.fn(), getCurrentUser: vi.fn(), findProject: vi.fn() };
  const credentials = { assertKeyConfigured: vi.fn(), save: vi.fn(), resolve: vi.fn(), markInvalid: vi.fn() };
  const broker = { evictRepo: vi.fn() };
  const activity = { record: vi.fn() };
  const tx = { run: vi.fn(<T>(fn: () => Promise<T>) => fn()), isInTransaction: () => false };
  const make = () => new FleetReposService(
    repo as never, github as never, gitlab as never, credentials as never, broker as never,
    { gitlabBotName: 'koda-fleet' } as never, activity as never, tx as never,
    mockAuditRecorder, { canHoldKey: vi.fn().mockResolvedValue(true) } as never,
  );

  /** A registered GitLab repo with its credential record: the project id is 42. */
  const gitlabRow = (over: Record<string, unknown> = {}) => ({
    id: 'fr1', projectId: 'p1', provider: 'gitlab', owner: 'group', name: 'app', defaultBranch: 'main',
    githubInstallationId: null, createdById: 'u1', createdAt: new Date(0), autoReview: false,
    autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null,
    autoReviewEnabledByType: null, autoReviewEnabledAt: null, host: 'https://gitlab.com',
    gitlabCredential: {
      gitlabProjectId: 42, readTokenUsername: 'koda-reader', writeTokenUsername: 'koda-bot',
      writeTokenIsBot: true, readTokenExpiresAt: null, writeTokenExpiresAt: null,
      readTokenInvalidAt: null, writeTokenInvalidAt: null,
    },
    ...over,
  });

  /** The scopes a token answers with: the write token writes, the read token only reads. */
  const scopes = (write: string[], read: string[]) => async (_apiBase: string, token: string) => ({
    scopes: token.startsWith('glpat-write') ? write : read,
    expiresAt: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '192.168.1.20', family: isIP('192.168.1.20') }]);
    repo.findById.mockResolvedValue(gitlabRow());
    credentials.assertKeyConfigured.mockReturnValue(undefined);
    credentials.save.mockResolvedValue(undefined);
    gitlab.getTokenSelf.mockImplementation(scopes(['api', 'write_repository'], ['read_api', 'read_repository']));
    gitlab.getCurrentUser.mockImplementation(async (_apiBase: string, token: string) => (
      token.startsWith('glpat-write')
        ? { id: 7, username: 'koda-fleet', bot: true }
        : { id: 8, username: 'koda-reader', bot: true }
    ));
    gitlab.findProject.mockResolvedValue({ id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 30 });
  });

  it('AC-6: a successful rotation evicts the repo id after the credential is stored', async () => {
    const order: string[] = [];
    credentials.save.mockImplementation(async () => { order.push('save'); });
    broker.evictRepo.mockImplementation(() => { order.push('evict'); });

    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(broker.evictRepo).toHaveBeenCalledWith('fr1');
    expect(order).toEqual(['save', 'evict']);
  });

  it('AC-6: the rotation stores the new write token against the stored project id', async () => {
    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(credentials.save).toHaveBeenCalledWith('fr1', {
      gitlabProjectId: 42,
      write: { token: 'glpat-write-2', userId: 7, username: 'koda-fleet', expiresAt: null, isBot: true },
    });
  });

  it('AC-6: the untouched token is not part of the write', async () => {
    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    const [, write] = credentials.save.mock.calls[0] as [string, { read?: unknown; write?: unknown }];
    expect(write.read).toBeUndefined();
  });

  it('AC-7: a failed rotation neither stores a credential nor evicts the cache', async () => {
    gitlab.findProject.mockRejectedValue(new RepoCheckException('repo_not_found'));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toBeInstanceOf(RepoCheckException);

    expect(credentials.save).not.toHaveBeenCalled();
    expect(broker.evictRepo).not.toHaveBeenCalled();
  });

  it('AC-4: a write token that cannot see the stored project is a project mismatch', async () => {
    gitlab.findProject.mockRejectedValue(new RepoCheckException('repo_not_found'));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ reason: 'gitlab_project_mismatch' });

    expect(credentials.save).not.toHaveBeenCalled();
    expect(broker.evictRepo).not.toHaveBeenCalled();
  });

  it('AC-5: a read token that may also write is refused', async () => {
    gitlab.getTokenSelf.mockImplementation(scopes(['api', 'write_repository'], ['read_api', 'read_repository', 'write_repository']));

    await expect(make().rotateGitlabCredentials('fr1', { readToken: 'glpat-read-2' }))
      .rejects.toMatchObject({ reason: 'gitlab_read_token_writable' });

    expect(credentials.save).not.toHaveBeenCalled();
    expect(broker.evictRepo).not.toHaveBeenCalled();
  });

  it('AC-14: a token the instance refuses with a 401 is an invalid token', async () => {
    gitlab.getTokenSelf.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ reason: 'gitlab_token_invalid' });

    expect(credentials.save).not.toHaveBeenCalled();
    expect(broker.evictRepo).not.toHaveBeenCalled();
  });

  it('AC-8: rotating both tokens records the summary of both', async () => {
    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2', readToken: 'glpat-read-2' });

    expect(credentials.save).toHaveBeenCalledWith('fr1', {
      gitlabProjectId: 42,
      write: { token: 'glpat-write-2', userId: 7, username: 'koda-fleet', expiresAt: null, isBot: true },
      read: { token: 'glpat-read-2', userId: 8, username: 'koda-reader', expiresAt: null },
    });
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({
      key: 'fleet.repo.credentials.update', resourceType: 'fleet-repo', resourceId: 'fr1',
      projectId: 'p1', summary: 'read and write tokens replaced',
    });
  });

  it('AC-8: rotating the write token alone records the write summary', async () => {
    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'fleet.repo.credentials.update', summary: 'write token replaced',
    }));
  });

  it('AC-8: rotating the read token alone records the read summary', async () => {
    await make().rotateGitlabCredentials('fr1', { readToken: 'glpat-read-2' });

    expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({
      read: expect.objectContaining({ token: 'glpat-read-2' }),
    }));
    expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
      key: 'fleet.repo.credentials.update', summary: 'read token replaced',
    }));
  });

  it('AC-9: a write token of a person is stored as a person', async () => {
    gitlab.getCurrentUser.mockImplementation(async (_apiBase: string, token: string) => (
      token.startsWith('glpat-write')
        ? { id: 7, username: 'alice', bot: false }
        : { id: 8, username: 'koda-reader', bot: true }
    ));

    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({
      write: expect.objectContaining({ isBot: false, username: 'alice' }),
    }));
  });

  it('AC-9: the admin may confirm the bot account', async () => {
    gitlab.getCurrentUser.mockImplementation(async (_apiBase: string, token: string) => (
      token.startsWith('glpat-write')
        ? { id: 7, username: 'alice', bot: false }
        : { id: 8, username: 'koda-reader', bot: true }
    ));

    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2', confirmBotAccount: true });

    expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({
      write: expect.objectContaining({ isBot: true }),
    }));
  });

  it('the new token is verified against the stored project id and the stored host', async () => {
    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(gitlab.getTokenSelf).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write-2');
    expect(gitlab.getCurrentUser).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write-2');
    expect(gitlab.findProject).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write-2', '42');
  });

  it('the host rule runs before any GitLab call', async () => {
    repo.findById.mockResolvedValue(gitlabRow({ host: 'https://git.corp.example' }));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ reason: 'gitlab_host_unclassified' });

    expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
    expect(gitlab.getCurrentUser).not.toHaveBeenCalled();
    expect(gitlab.findProject).not.toHaveBeenCalled();
  });

  it('a deployment without an encryption key costs no outbound call', async () => {
    credentials.assertKeyConfigured.mockImplementation(() => { throw new RepoCheckException('vcs_encryption_key_missing'); });

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ reason: 'vcs_encryption_key_missing' });

    expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
  });

  it('no GitLab call happens inside the transaction that stores the credential', async () => {
    const order: string[] = [];
    tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { order.push('begin'); const value = await fn(); order.push('end'); return value; });
    gitlab.getTokenSelf.mockImplementation(async () => { order.push('token-self'); return { scopes: ['api', 'write_repository'], expiresAt: null }; });
    gitlab.getCurrentUser.mockImplementation(async () => { order.push('user'); return { id: 7, username: 'koda-fleet', bot: true }; });
    gitlab.findProject.mockImplementation(async () => { order.push('project'); return { id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 30 }; });
    credentials.save.mockImplementation(async () => { order.push('save'); });

    await make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' });

    expect(order).toEqual(['token-self', 'user', 'project', 'begin', 'save', 'end']);
  });

  it('a body without a token is refused', async () => {
    await expect(make().rotateGitlabCredentials('fr1', {})).rejects.toBeInstanceOf(ValidationAppException);

    expect(credentials.save).not.toHaveBeenCalled();
    expect(broker.evictRepo).not.toHaveBeenCalled();
  });

  it('a GitHub repo cannot rotate GitLab credentials', async () => {
    repo.findById.mockResolvedValue(gitlabRow({ provider: 'github', host: 'https://github.com' }));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toBeInstanceOf(ValidationAppException);

    expect(credentials.save).not.toHaveBeenCalled();
    expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
  });

  it('a repo without a credential record has no project to verify a token against', async () => {
    repo.findById.mockResolvedValue(gitlabRow({ gitlabCredential: null }));

    await expect(make().rotateGitlabCredentials('fr1', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ reason: 'gitlab_credentials_missing' });

    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('an unknown repo is a 404 before any GitLab call', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(make().rotateGitlabCredentials('missing', { writeToken: 'glpat-write-2' }))
      .rejects.toMatchObject({ status: 404 });

    expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
  });
});
