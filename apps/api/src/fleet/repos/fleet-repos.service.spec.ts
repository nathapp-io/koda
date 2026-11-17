import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isIP } from 'node:net';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from './fleet-repos.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

/**
 * US-002 (GitLab parity F1): the host rule resolves an address before every request, so the
 * resolver is stubbed here — never relaxed. The addresses the stub answers with are inside an
 * allowed subnet, so the production rule stays strict.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

describe('FleetReposService', () => {
  const repo = { findProject: vi.fn(), create: vi.fn(), findById: vi.fn(), findPage: vi.fn(), findAutoReviewPage: vi.fn(), delete: vi.fn(), lockForDelete: vi.fn(), countUnfinishedJobs: vi.fn(), findGitLabByRemote: vi.fn() };
  const github = { verifyRepo: vi.fn() };
  const gitlab = { getTokenSelf: vi.fn(), getCurrentUser: vi.fn(), findProject: vi.fn() };
  /** US-004: the per-repo credential store replaces the old project-wide token source. */
  const credentials = { assertKeyConfigured: vi.fn(), save: vi.fn(), resolve: vi.fn(), markInvalid: vi.fn() };
  /** US-005 evicts a repo's cached tokens after a rotation. */
  const broker = { evictRepo: vi.fn() };
  const activity = { record: vi.fn() };
  const tx = { run: vi.fn(<T>(fn: () => Promise<T>) => fn()), isInTransaction: () => false };
  const make = () => new FleetReposService(
    repo as never, github as never, gitlab as never, credentials as never, broker as never,
    { gitlabBotName: 'koda-fleet' } as never, activity as never, tx as never,
    mockAuditRecorder, { canHoldKey: vi.fn().mockResolvedValue(true) } as never,
  );

  const created = (over = {}) => ({
    id: 'fr1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk',
    host: 'https://github.com',
    githubInstallationId: BigInt(77), createdById: 'u1', createdAt: new Date(0), autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  /** The GitLab body of a registration: the two tokens and the repo they open. */
  const gitlabBody = (over: Record<string, unknown> = {}) => ({
    projectSlug: 'p', provider: 'gitlab' as const, owner: 'group', name: 'app',
    readToken: 'glpat-read', writeToken: 'glpat-write', ...over,
  });

  /** The scopes a working pair of tokens answers with. */
  const scopes = (write: string[], read: string[]) => async (_apiBase: string, token: string) =>
    ({ scopes: token === 'glpat-write' ? write : read, expiresAt: null });

  /** The accounts behind the two tokens. */
  const users = (write: { id: number; username: string; bot: boolean }, read: { id: number; username: string; bot: boolean }) =>
    async (_apiBase: string, token: string) => (token === 'glpat-write' ? write : read);

  beforeEach(() => {
    vi.clearAllMocks();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '192.168.1.20', family: isIP('192.168.1.20') }]);
    repo.findProject.mockResolvedValue({ id: 'p1', slug: 'p' });
    credentials.assertKeyConfigured.mockReturnValue(undefined);
    credentials.save.mockResolvedValue(undefined);
    gitlab.getTokenSelf.mockImplementation(scopes(['api', 'write_repository'], ['read_api', 'read_repository']));
    gitlab.getCurrentUser.mockImplementation(users(
      { id: 7, username: 'koda-fleet', bot: true },
      { id: 8, username: 'koda-reader', bot: true },
    ));
    gitlab.findProject.mockResolvedValue({ id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 30 });
    repo.create.mockResolvedValue(created());
    repo.findById.mockResolvedValue(created());
  });

  it('findIdentity returns the narrow repository identity or null', async () => {
    repo.findById.mockResolvedValue(created({ provider: 'github', owner: 'nathapp-io', name: 'sandbox' }));
    await expect(make().findIdentity('fr1')).resolves.toEqual({ provider: 'github', owner: 'nathapp-io', name: 'sandbox' });
    repo.findById.mockResolvedValue(null);
    await expect(make().findIdentity('missing')).resolves.toBeNull();
  });

  it('findReviewRepo returns null for an unknown id', async () => {
    repo.findById.mockResolvedValue(null);
    expect(await make().findReviewRepo('unknown')).toBeNull();
    expect(repo.findById).toHaveBeenCalledWith('unknown');
  });

  it('findReviewRepo exposes only the review projection, preserving bigint and null', async () => {
    for (const installation of [77n, null]) {
      repo.findById.mockResolvedValue(created({ githubInstallationId: installation }));
      expect(await make().findReviewRepo('fr1')).toEqual({
        id: 'fr1', projectId: 'p1', owner: 'acme', name: 'app', githubInstallationId: installation,
        defaultBranch: 'trunk', provider: 'github', host: 'https://github.com',
      });
    }
  });

  it('US-006 AC-2: the review projection carries a GitLab repo provider and its own host', async () => {
    repo.findById.mockResolvedValue(created({ provider: 'gitlab', host: 'https://gitlab.example.com', githubInstallationId: null }));
    expect(await make().findReviewRepo('fr1')).toEqual({
      id: 'fr1', projectId: 'p1', owner: 'acme', name: 'app', githubInstallationId: null,
      defaultBranch: 'trunk', provider: 'gitlab', host: 'https://gitlab.example.com',
    });
  });

  it('delegates the auto-review repo limit to the repository', async () => {
    const records = [created()];
    repo.findAutoReviewPage.mockResolvedValue(records);
    await expect(make().listAutoReviewRepos(50)).resolves.toBe(records);
    expect(repo.findAutoReviewPage).toHaveBeenCalledWith(50);
  });

  it('prepared checks refuse a target changed during HTTP without calling the forge again', async () => {
    repo.findById.mockResolvedValue(created());
    github.verifyRepo.mockResolvedValue({});
    const run = await make().prepareCheck('fr1');
    repo.findById.mockResolvedValue(created({ owner: 'other' }));
    await expect(run()).rejects.toBeInstanceOf(ConflictAppException);
    expect(github.verifyRepo).toHaveBeenCalledTimes(1);
  });

  it('prepared creates recheck the project before writing', async () => {
    github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: 77n });
    const run = await make().prepareCreate('u1', { projectSlug: 'p', provider: 'github', owner: 'acme', name: 'app' });
    repo.findProject.mockResolvedValue(null);
    await expect(run()).rejects.toBeInstanceOf(NotFoundAppException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('registers a GitHub repo under its canonical name and serialises the BigInt as a string', async () => {
    github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
    repo.create.mockResolvedValue(created());
    const dto = await make().create('u1', { projectSlug: 'p', provider: 'github', owner: 'Acme', name: 'App' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) }));
    expect(dto.githubInstallationId).toBe('77');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.created', entityId: 'fr1' }));
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({ key: 'fleet.repo.create', resourceType: 'fleet-repo', resourceId: 'fr1', projectId: 'p1', summary: 'registered github' });
  });

  it('404s an unknown project before calling the forge', async () => {
    repo.findProject.mockResolvedValue(null);
    await expect(make().create('u1', { projectSlug: 'x', provider: 'github', owner: 'a', name: 'b' })).rejects.toBeInstanceOf(NotFoundAppException);
    expect(github.verifyRepo).not.toHaveBeenCalled();
  });

  describe('US-004: the GitLab registration', () => {
    beforeEach(() => {
      const gitlabRow = created({ provider: 'gitlab', owner: 'group', name: 'app', githubInstallationId: null, host: 'https://gitlab.com' });
      repo.create.mockResolvedValue(gitlabRow);
      repo.findById.mockResolvedValue(gitlabRow);
    });

    it('AC-2: refuses a host that is not https before any GitLab call', async () => {
      await expect(make().create('u1', gitlabBody({ host: 'http://gitlab.example.com' }))).rejects.toMatchObject({ reason: 'gitlab_host_invalid' });
      expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
      expect(gitlab.getCurrentUser).not.toHaveBeenCalled();
      expect(gitlab.findProject).not.toHaveBeenCalled();
    });

    it('AC-3: refuses a host that does not name a GitLab instance before any GitLab call', async () => {
      await expect(make().create('u1', gitlabBody({ host: 'https://git.corp.example' }))).rejects.toMatchObject({ reason: 'gitlab_host_unclassified' });
      expect(gitlab.getTokenSelf).not.toHaveBeenCalled();
      expect(gitlab.getCurrentUser).not.toHaveBeenCalled();
      expect(gitlab.findProject).not.toHaveBeenCalled();
    });

    it('AC-4: without a host it verifies against gitlab.com', async () => {
      await make().create('u1', gitlabBody());
      expect(gitlab.getTokenSelf).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write');
      expect(gitlab.getTokenSelf).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-read');
      expect(gitlab.findProject).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write', 'group/app');
    });

    it('AC-4: the host the body names is the one the requests go to', async () => {
      await make().create('u1', gitlabBody({ host: 'https://gitlab.example.com' }));
      expect(gitlab.getTokenSelf).toHaveBeenCalledWith('https://gitlab.example.com/api/v4', 'glpat-write');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ host: 'https://gitlab.example.com' }));
    });

    it('AC-5: refuses a write token without the write scopes before anything is stored', async () => {
      gitlab.getTokenSelf.mockImplementation(scopes(['read_api'], ['read_api', 'read_repository']));
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_scope_missing' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-5: refuses a read token without the read scopes before anything is stored', async () => {
      gitlab.getTokenSelf.mockImplementation(scopes(['api', 'write_repository'], ['api']));
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_scope_missing' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-6: refuses a read token that may also write', async () => {
      gitlab.getTokenSelf.mockImplementation(scopes(['api', 'write_repository'], ['read_api', 'read_repository', 'api']));
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_read_token_writable' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-7: refuses a repo the write token cannot develop', async () => {
      gitlab.findProject.mockResolvedValue({ id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 20 });
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_access_insufficient' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-8: refuses a read token that cannot see the project', async () => {
      gitlab.findProject.mockImplementation(async (_apiBase: string, token: string) => {
        if (token === 'glpat-read') throw new RepoCheckException('repo_not_found');
        return { id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 30 };
      });
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_read_token_no_access' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-12: a token the instance does not know is refused and nothing is stored', async () => {
      gitlab.getTokenSelf.mockRejectedValue(new RepoCheckException('gitlab_token_invalid'));
      await expect(make().create('u1', gitlabBody())).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });
      expect(credentials.save).not.toHaveBeenCalled();
    });

    it('AC-10: a write token of a person is stored as a person and the audit says so', async () => {
      gitlab.getCurrentUser.mockImplementation(users(
        { id: 7, username: 'alice', bot: false },
        { id: 8, username: 'koda-reader', bot: true },
      ));
      await make().create('u1', gitlabBody());
      expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({
        gitlabProjectId: 42,
        write: expect.objectContaining({ isBot: false, username: 'alice', userId: 7, token: 'glpat-write' }),
        read: expect.objectContaining({ username: 'koda-reader', userId: 8, token: 'glpat-read' }),
      }));
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({
        key: 'fleet.repo.create', summary: 'registered gitlab; write token belongs to a person (alice)',
      }));
    });

    it('AC-10: the configured bot name makes the write token a bot token', async () => {
      gitlab.getCurrentUser.mockImplementation(users(
        { id: 7, username: 'koda-fleet', bot: false },
        { id: 8, username: 'koda-reader', bot: true },
      ));
      await make().create('u1', gitlabBody());
      expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({ write: expect.objectContaining({ isBot: true }) }));
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'registered gitlab' }));
    });

    it('AC-11: the admin may confirm the bot account', async () => {
      gitlab.getCurrentUser.mockImplementation(users(
        { id: 7, username: 'alice', bot: false },
        { id: 8, username: 'koda-reader', bot: true },
      ));
      await make().create('u1', gitlabBody({ confirmBotAccount: true }));
      expect(credentials.save).toHaveBeenCalledWith('fr1', expect.objectContaining({ write: expect.objectContaining({ isBot: true }) }));
      expect(mockAuditRecorder.record).toHaveBeenCalledWith(expect.objectContaining({ summary: 'registered gitlab' }));
    });

    it('stores the credential in the create transaction, right after the repo row', async () => {
      const order: string[] = [];
      tx.run.mockImplementation(async (fn: () => Promise<unknown>) => { order.push('begin'); const value = await fn(); order.push('end'); return value; });
      repo.create.mockImplementation(async () => { order.push('create'); return created({ provider: 'gitlab', githubInstallationId: null }); });
      credentials.save.mockImplementation(async () => { order.push('save'); });
      await make().create('u1', gitlabBody());
      expect(order).toEqual(['begin', 'create', 'save', 'end']);
    });

    it('answers the stored row, so the response carries the credential summary', async () => {
      repo.findById.mockResolvedValue(created({
        provider: 'gitlab', owner: 'group', name: 'app', githubInstallationId: null, host: 'https://gitlab.com',
        gitlabCredential: {
          gitlabProjectId: 42, readTokenUsername: 'koda-reader', writeTokenUsername: 'alice', writeTokenIsBot: false,
          readTokenExpiresAt: null, writeTokenExpiresAt: null, readTokenInvalidAt: null, writeTokenInvalidAt: null,
        },
      }));
      const dto = await make().create('u1', gitlabBody());
      expect(dto.gitlab).toMatchObject({ projectId: 42, warnings: ['write_token_human'] });
      expect(dto.gitlab?.writeToken).toMatchObject({ username: 'alice', isBot: false });
    });
  });

  describe('US-004: the GitLab reachability check', () => {
    const gitlabRow = created({ provider: 'gitlab', owner: 'group', name: 'app', githubInstallationId: null, host: 'https://gitlab.com' });
    const access = (token: string) => ({ token, target: { apiBase: 'https://gitlab.com/api/v4', projectId: 42 } });

    beforeEach(() => {
      repo.findById.mockResolvedValue(gitlabRow);
      credentials.resolve.mockImplementation(async (_repo: unknown, kind: string) => access(kind === 'read' ? 'glpat-read' : 'glpat-write'));
    });

    it('AC-15: a stored read token the instance refuses is reported, and only the closure marks it', async () => {
      gitlab.findProject.mockImplementation(async (_apiBase: string, token: string) => {
        if (token === 'glpat-read') throw new RepoCheckException('gitlab_token_invalid');
        return { id: 42, owner: 'group', name: 'app', defaultBranch: 'main', accessLevel: 30 };
      });
      const run = await make().prepareCheck('fr1');
      expect(credentials.markInvalid).not.toHaveBeenCalled();
      const result = await run();
      expect(result).toMatchObject({ repoId: 'fr1', reachable: false, reason: 'gitlab_token_invalid' });
      expect(credentials.markInvalid).toHaveBeenCalledWith('fr1', 'read');
    });

    it('AC-15: a credential summary that changed in between is not a conflict', async () => {
      const changed = { ...gitlabRow, gitlabCredential: { gitlabProjectId: 42, readTokenUsername: 'koda-reader', writeTokenUsername: 'alice', writeTokenIsBot: false, readTokenExpiresAt: null, writeTokenExpiresAt: null, readTokenInvalidAt: new Date(), writeTokenInvalidAt: null } };
      repo.findById.mockResolvedValueOnce(gitlabRow).mockResolvedValue(changed);
      const run = await make().prepareCheck('fr1');
      await expect(run()).resolves.toMatchObject({ reachable: true, reason: null });
    });

    it('checks the stored project with the stored tokens', async () => {
      await make().check('fr1');
      expect(credentials.resolve).toHaveBeenCalledWith(gitlabRow, 'read');
      expect(credentials.resolve).toHaveBeenCalledWith(gitlabRow, 'write');
      expect(gitlab.findProject).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-write', 42);
      expect(gitlab.findProject).toHaveBeenCalledWith('https://gitlab.com/api/v4', 'glpat-read', 42);
      expect(gitlab.getCurrentUser).not.toHaveBeenCalled();
    });
  });

  describe('the GitLab remote lookup', () => {
    const gitlabRow = created({ provider: 'gitlab', owner: 'grp', name: 'app', githubInstallationId: null, host: 'https://gitlab.com' });

    it('asks the repository for the complete identity, not for the name alone', async () => {
      repo.findGitLabByRemote.mockResolvedValue([gitlabRow]);

      await expect(make().findGitLabByRemoteUrl('https://gitlab.com/grp/app')).resolves.toBe(gitlabRow);

      // The identity is the whole identity of the row: the repository filters on it before it reads
      // a bounded page, so same-named rows on other hosts cannot hide the registered repo.
      expect(repo.findGitLabByRemote).toHaveBeenCalledWith([{ host: 'https://gitlab.com', owner: 'grp', name: 'app' }]);
    });

    it('answers null when no registered row carries the identity', async () => {
      repo.findGitLabByRemote.mockResolvedValue([]);
      await expect(make().findGitLabByRemoteUrl('https://gitlab.com/grp/app')).resolves.toBeNull();
    });

    it('reads nothing for a remote that names no identity', async () => {
      await expect(make().findGitLabByRemoteUrl('not a url')).resolves.toBeNull();
      expect(repo.findGitLabByRemote).not.toHaveBeenCalled();
    });
  });

  it('deletes and records', async () => {
    repo.findById.mockResolvedValue(created());
    repo.countUnfinishedJobs.mockResolvedValue(0);
    await make().remove('u9', 'fr1');
    expect(repo.lockForDelete).toHaveBeenCalledWith('fr1');
    expect(repo.delete).toHaveBeenCalledWith('fr1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.deleted', entityId: 'fr1' }));
    expect(mockAuditRecorder.record).toHaveBeenCalledWith({ key: 'fleet.repo.delete', resourceType: 'fleet-repo', resourceId: 'fr1', projectId: 'p1', summary: 'deleted' });
  });

  it('409s a repo with unfinished jobs', async () => {
    repo.findById.mockResolvedValue(created());
    repo.countUnfinishedJobs.mockResolvedValue(1);
    await expect(make().remove('u9', 'fr1')).rejects.toBeInstanceOf(ConflictAppException);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  describe('check', () => {
    const now = new Date('2026-10-01T12:00:00.000Z');

    it('answers reachable for a GitHub repo the App can still reach', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
      expect(await make().check('fr1', now)).toEqual({ repoId: 'fr1', reachable: true, reason: null, checkedAt: now.toISOString() });
      expect(github.verifyRepo).toHaveBeenCalledWith('acme', 'app', BigInt(77));
    });

    it('checks the persisted GitHub installation even when the current installation has a different id', async () => {
      repo.findById.mockResolvedValue(created({ githubInstallationId: BigInt(77) }));
      github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(99) });

      await make().check('fr1', now);

      expect(github.verifyRepo).toHaveBeenCalledWith('acme', 'app', BigInt(77));
    });

    it('reports app_not_installed when a GitHub repo has no persisted installation id', async () => {
      repo.findById.mockResolvedValue(created({ githubInstallationId: null }));
      const result = await make().check('fr1', now);
      expect(result).toMatchObject({ reachable: false, reason: 'app_not_installed' });
      expect(github.verifyRepo).not.toHaveBeenCalled();
    });

    it('answers unreachable with the forge reason instead of throwing', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockRejectedValue(new RepoCheckException('app_not_installed'));
      expect(await make().check('fr1', now)).toEqual({ repoId: 'fr1', reachable: false, reason: 'app_not_installed', checkedAt: now.toISOString() });
    });

    it('rethrows anything that is not a forge verdict', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockRejectedValue(new Error('boom'));
      await expect(make().check('fr1', now)).rejects.toThrow('boom');
    });

    it('404s an unknown repo before calling the forge', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(make().check('nope', now)).rejects.toBeInstanceOf(NotFoundAppException);
      expect(github.verifyRepo).not.toHaveBeenCalled();
    });
  });
});
