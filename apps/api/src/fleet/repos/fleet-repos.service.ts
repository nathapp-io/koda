import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { decryptToken } from '../../common/utils/encryption.util';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import type { IVcsRepository } from '../../vcs/domain/vcs.repository';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FLEET_REPO_REPOSITORY, IFleetRepoRepository } from './domain/fleet-repo.domain';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';

@Injectable()
export class FleetReposService {
  constructor(
    @Inject(FLEET_REPO_REPOSITORY) private readonly repo: IFleetRepoRepository,
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'findVcsConnectionByProjectId'>,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'encryptionKey'>,
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
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
    if (!connection) throw new RepoCheckException('vcs_connection_missing');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (connection.provider !== 'gitlab' || !same(connection.repoOwner, owner) || !same(connection.repoName, name)) {
      throw new RepoCheckException('vcs_connection_mismatch');
    }
    if (!this.vcsConfig.encryptionKey) throw new RepoCheckException('vcs_encryption_key_missing');
    let token: string;
    try {
      token = decryptToken(connection.encryptedToken, this.vcsConfig.encryptionKey);
    } catch {
      throw new RepoCheckException('gitlab_token_invalid');
    }
    return this.gitlab.verifyRepo(owner, name, token);
  }

  async list(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetRepoDto.from);
  }

  /** Slice 2 adds the active-job 409 (plan D10). */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      await this.repo.delete(id);
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.deleted', entityType: 'repo', entityId: id,
        payload: { provider: row.provider, owner: row.owner, name: row.name },
      });
    });
  }
}
