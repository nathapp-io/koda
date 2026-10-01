import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from './fleet-repos.service';

describe('FleetReposService', () => {
  const repo = { findProject: jest.fn(), create: jest.fn(), findById: jest.fn(), findPage: jest.fn(), delete: jest.fn(), lockForDelete: jest.fn(), countUnfinishedJobs: jest.fn() };
  const github = { verifyRepo: jest.fn() };
  const gitlab = { verifyRepo: jest.fn() };
  const gitlabTokens = { resolve: jest.fn() };
  const activity = { record: jest.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const make = () => new FleetReposService(repo as never, github as never, gitlab as never, gitlabTokens as never, activity as never, tx as never);

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

  it('resolves the GitLab token from the project connection and verifies the repo with it', async () => {
    gitlabTokens.resolve.mockResolvedValue('glpat-1');
    gitlab.verifyRepo.mockResolvedValue({ owner: 'group', name: 'app', defaultBranch: 'main' });
    repo.create.mockResolvedValue(created({ provider: 'gitlab', owner: 'group', githubInstallationId: null }));
    await make().create('u1', { projectSlug: 'p', provider: 'gitlab', owner: 'group', name: 'app' });
    expect(gitlabTokens.resolve).toHaveBeenCalledWith('p1', 'group', 'app');
    expect(gitlab.verifyRepo).toHaveBeenCalledWith('group', 'app', 'glpat-1');
  });

  it('deletes and records', async () => {
    repo.findById.mockResolvedValue(created());
    repo.countUnfinishedJobs.mockResolvedValue(0);
    await make().remove('u9', 'fr1');
    expect(repo.lockForDelete).toHaveBeenCalledWith('fr1');
    expect(repo.delete).toHaveBeenCalledWith('fr1');
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'repo.deleted', entityId: 'fr1' }));
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
      expect(github.verifyRepo).toHaveBeenCalledWith('acme', 'app');
    });

    it('answers unreachable with the forge reason instead of throwing', async () => {
      repo.findById.mockResolvedValue(created());
      github.verifyRepo.mockRejectedValue(new RepoCheckException('app_not_installed'));
      expect(await make().check('fr1', now)).toEqual({ repoId: 'fr1', reachable: false, reason: 'app_not_installed', checkedAt: now.toISOString() });
    });

    it('checks a GitLab repo with the project token, and reports a lost connection as a reason', async () => {
      repo.findById.mockResolvedValue(created({ provider: 'gitlab', owner: 'group/sub', githubInstallationId: null }));
      gitlabTokens.resolve.mockRejectedValue(new RepoCheckException('vcs_connection_missing'));
      const result = await make().check('fr1', now);
      expect(gitlabTokens.resolve).toHaveBeenCalledWith('p1', 'group/sub', 'app');
      expect(result.reason).toBe('vcs_connection_missing');
      expect(gitlab.verifyRepo).not.toHaveBeenCalled();
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
