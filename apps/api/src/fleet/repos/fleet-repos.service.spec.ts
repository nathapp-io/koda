import { NotFoundAppException } from '@nathapp/nestjs-common';
import { encryptToken } from '../../common/utils/encryption.util';
import { FleetReposService } from './fleet-repos.service';
import { RepoCheckException } from '../git-broker/repo-check.exception';

const KEY = 'a'.repeat(64);

describe('FleetReposService', () => {
  const repo = { findProject: jest.fn(), create: jest.fn(), findById: jest.fn(), findPage: jest.fn(), delete: jest.fn() };
  const vcsRepo = { findVcsConnectionByProjectId: jest.fn() };
  const github = { verifyRepo: jest.fn() };
  const gitlab = { verifyRepo: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const make = (encryptionKey: string | undefined = KEY) =>
    new FleetReposService(repo as never, vcsRepo as never, github as never, gitlab as never, activity as never, tx as never, { encryptionKey } as never);

  const created = (over = {}) => ({
    id: 'fr1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk',
    githubInstallationId: BigInt(77), createdById: 'u1', createdAt: new Date(0), ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repo.findProject.mockResolvedValue({ id: 'p1', slug: 'p' });
  });

  it('registers a GitHub repo under its canonical name and serialises the BigInt as a string', async () => {
    github.verifyRepo.mockResolvedValue({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
    repo.create.mockResolvedValue(created());
    const dto = await make().create('u1', { projectSlug: 'p', provider: 'github', owner: 'Acme', name: 'App' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: BigInt(77) }));
    expect(dto.githubInstallationId).toBe('77');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.created', entityId: 'fr1' }));
  });

  it('404s an unknown project before calling the forge', async () => {
    repo.findProject.mockResolvedValue(null);
    await expect(make().create('u1', { projectSlug: 'x', provider: 'github', owner: 'a', name: 'b' })).rejects.toBeInstanceOf(NotFoundAppException);
    expect(github.verifyRepo).not.toHaveBeenCalled();
  });

  it('requires a matching GitLab VcsConnection and decrypts its token', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'Group', repoName: 'App', encryptedToken: encryptToken('glpat-1', KEY) });
    gitlab.verifyRepo.mockResolvedValue({ owner: 'group', name: 'app', defaultBranch: 'main' });
    repo.create.mockResolvedValue(created({ provider: 'gitlab', owner: 'group', githubInstallationId: null }));
    await make().create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' });
    expect(gitlab.verifyRepo).toHaveBeenCalledWith('group', 'app', 'glpat-1');
  });

  it.each([
    ['no connection', null, 'vcs_connection_missing'],
    ['a GitHub connection', { provider: 'github', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
    ['another repo', { provider: 'gitlab', repoOwner: 'group', repoName: 'other', encryptedToken: 'x' }, 'vcs_connection_mismatch'],
  ])('rejects GitLab registration with %s', async (_label, connection, reason) => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue(connection);
    await expect(make().create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' })).rejects.toMatchObject({ reason: reason });
  });

  it('rejects GitLab registration without VCS_ENCRYPTION_KEY', async () => {
    vcsRepo.findVcsConnectionByProjectId.mockResolvedValue({ provider: 'gitlab', repoOwner: 'group', repoName: 'app', encryptedToken: 'x' });
    // NB: `make(undefined)` would hit the `= KEY` default and test the wrong path;
    // an empty key is falsy and exercises the vcs_encryption_key_missing branch.
    await expect(make('').create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' })).rejects.toMatchObject({ reason: 'vcs_encryption_key_missing' });
  });
});
