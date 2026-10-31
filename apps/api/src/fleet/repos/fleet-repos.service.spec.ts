import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from './fleet-repos.service';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';

describe('FleetReposService', () => {
  const repo = { findProject: vi.fn(), create: vi.fn(), findById: vi.fn(), findPage: vi.fn(), findAutoReviewPage: vi.fn(), delete: vi.fn(), lockForDelete: vi.fn(), countUnfinishedJobs: vi.fn() };
  const github = { verifyRepo: vi.fn() };
  const gitlab = { verifyRepo: vi.fn() };
  const gitlabTokens = { resolve: vi.fn() };
  const activity = { record: vi.fn() };
  const tx = { run: <T>(fn: () => Promise<T>) => fn(), isInTransaction: () => false };
  const make = () => new FleetReposService(repo as never, github as never, gitlab as never, gitlabTokens as never, activity as never, tx as never, mockAuditRecorder, { canHoldKey: vi.fn().mockResolvedValue(true) } as never);

  const created = (over = {}) => ({
    id: 'fr1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'trunk',
    githubInstallationId: BigInt(77), createdById: 'u1', createdAt: new Date(0), autoReview: false, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000', autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findProject.mockResolvedValue({ id: 'p1', slug: 'p' });
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
