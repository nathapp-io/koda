import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FLEET_REPO_REPOSITORY, IFleetRepoRepository } from './domain/fleet-repo.domain';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';

@Injectable()
export class FleetReposService {
  constructor(
    @Inject(FLEET_REPO_REPOSITORY) private readonly repo: IFleetRepoRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async create(actorId: string, dto: CreateFleetRepoDto): Promise<FleetRepoDto> {
    const project = await this.repo.findProject(dto.projectSlug);
    if (!project) throw new NotFoundAppException({}, 'projects');

    // Forge checks run before the transaction: no DB transaction is held across HTTP.
    const verified = dto.provider === 'github'
      ? await this.github.verifyRepo(dto.owner, dto.name)
      : { ...(await this.verifyGitLab(project.id, dto.owner, dto.name)), installationId: null };

    return this.txManager.run(async () => {
      const row = await this.repo.create({
        projectId: project.id,
        provider: dto.provider,
        owner: verified.owner,
        name: verified.name,
        defaultBranch: verified.defaultBranch,
        githubInstallationId: verified.installationId,
        createdById: actorId,
      });
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.created', entityType: 'repo', entityId: row.id,
        payload: { projectId: project.id, provider: row.provider, owner: row.owner, name: row.name },
      });
      return FleetRepoDto.from(row);
    });
  }

  private async verifyGitLab(projectId: string, owner: string, name: string) {
    return this.gitlab.verifyRepo(owner, name, await this.gitlabTokens.resolve(projectId, owner, name));
  }

  async list(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetRepoDto.from);
  }

  /**
   * Deletion is refused while any job on the repo is unfinished (plan D15). The row
   * is locked FOR UPDATE first so the count sees a stable row (review m6).
   */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      await this.repo.lockForDelete(id);
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      if ((await this.repo.countUnfinishedJobs(id)) > 0) throw new ConflictAppException({}, 'fleet.repoBusy');
      await this.repo.delete(id);
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.deleted', entityType: 'repo', entityId: id,
        payload: { provider: row.provider, owner: row.owner, name: row.name },
      });
    });
  }

  /**
   * Re-runs the registration forge check (overview D119): can koda still broker git for this repo?
   * A forge verdict is returned as data; anything else is a real error and propagates.
   */
  async check(id: string, now = new Date()): Promise<RepoCheckResultDto> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    const result = (reachable: boolean, reason: RepoCheckResultDto['reason']) =>
      Object.assign(new RepoCheckResultDto(), { repoId: id, reachable, reason, checkedAt: now.toISOString() });
    try {
      if (row.provider === 'github') await this.github.verifyRepo(row.owner, row.name);
      else await this.verifyGitLab(row.projectId, row.owner, row.name);
      return result(true, null);
    } catch (error) {
      if (error instanceof RepoCheckException) return result(false, error.reason);
      throw error;
    }
  }
}
