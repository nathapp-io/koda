import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import { PROFILE_NAME_RE } from '../common/capabilities';
import { RESERVED_PROFILE_PREFIX } from '../jobs/dispatch-input';
import { AutoReviewException } from './auto-review.exception';
import type { AutoReviewPatch } from './domain/fleet-repo.domain';
import { PermissionService } from '../../permissions/permission.service';
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
import type { FleetRepoRecord } from './domain/fleet-repo.domain';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
import { AuditRecorder } from '../../audit/audit-recorder.service';

@Injectable()
export class FleetReposService {
  constructor(
    @Inject(FLEET_REPO_REPOSITORY) private readonly repo: IFleetRepoRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
    private readonly permissions: PermissionService,
  ) {}

  async create(actorId: string, dto: CreateFleetRepoDto): Promise<FleetRepoDto> {
    return (await this.prepareCreate(actorId, dto))();
  }

  async prepareCreate(actorId: string, dto: CreateFleetRepoDto): Promise<() => Promise<FleetRepoDto>> {
    const project = await this.repo.findProject(dto.projectSlug);
    if (!project) throw new NotFoundAppException({}, 'projects');

    // Forge checks run before the transaction: no DB transaction is held across HTTP.
    const verified = dto.provider === 'github'
      ? await this.github.verifyRepo(dto.owner, dto.name)
      : { ...(await this.verifyGitLab(project.id, dto.owner, dto.name)), installationId: null };

    return () => this.txManager.run(async () => {
      const current = await this.repo.findProject(dto.projectSlug);
      if (!current || current.id !== project.id) throw new NotFoundAppException({}, 'projects');
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
      await this.audit.record({ key: 'fleet.repo.create', resourceType: 'fleet-repo', resourceId: row.id, projectId: row.projectId, summary: `registered ${row.provider}` });
      return FleetRepoDto.from(row);
    });
  }

  private async verifyGitLab(projectId: string, owner: string, name: string) {
    return this.gitlab.verifyRepo(owner, name, await this.gitlabTokens.resolve(projectId, owner, name));
  }

  async configureAutoReview(principal: UserPrincipal | AgentPrincipal, id: string, dto: UpdateAutoReviewDto): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      const patch: AutoReviewPatch = dto.enabled
        ? { autoReview: true }
        : { autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null };

      if (dto.enabled) {
        if (row.provider !== 'github' || row.githubInstallationId === null) throw new AutoReviewException('github app required');
        const profiles = dto.profiles ?? [];
        if (profiles.some((profile) => !PROFILE_NAME_RE.test(profile) || profile.startsWith(RESERVED_PROFILE_PREFIX))) throw new AutoReviewException('profiles');
        if (new Set(profiles).size !== profiles.length) throw new AutoReviewException('duplicate profile');
        const caller = { type: principal.actorType === 'user' ? 'USER' as const : 'AGENT' as const, id: principal.id };
        if (!(await this.permissions.canHoldKey(caller, 'fleet.job.dispatch', { projectId: row.projectId }))) {
          throw new AutoReviewException('caller cannot dispatch in this project');
        }
        if (dto.profiles !== undefined) patch.autoReviewProfiles = [...dto.profiles];
        if (dto.maxCostUsd !== undefined) patch.autoReviewMaxCostUsd = String(dto.maxCostUsd);
        patch.autoReviewEnabledById = principal.id;
        patch.autoReviewEnabledByType = caller.type;
        patch.autoReviewEnabledAt = row.autoReview ? row.autoReviewEnabledAt : new Date();
      }

      const updated = await this.repo.updateAutoReview(id, patch);
      await this.audit.record({ key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId, summary: dto.enabled ? 'enabled' : 'disabled' });
      return FleetRepoDto.from(updated);
    });
  }

  async listAutoReviewRepos(limit: number): Promise<FleetRepoRecord[]> {
    return this.repo.findAutoReviewPage(limit);
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
      await this.audit.record({ key: 'fleet.repo.delete', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId, summary: 'deleted' });
    });
  }

  /**
   * Re-runs the registration forge check (overview D119): can koda still broker git for this repo?
   * A forge verdict is returned as data; anything else is a real error and propagates.
   */
  async check(id: string, now = new Date()): Promise<RepoCheckResultDto> {
    return (await this.prepareCheck(id, now))();
  }

  async prepareCheck(id: string, now = new Date()): Promise<() => Promise<RepoCheckResultDto>> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    const result = (reachable: boolean, reason: RepoCheckResultDto['reason']) =>
      Object.assign(new RepoCheckResultDto(), { repoId: id, reachable, reason, checkedAt: now.toISOString() });
    let checked: RepoCheckResultDto;
    try {
      if (row.provider === 'github') {
        if (row.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
        await this.github.verifyRepo(row.owner, row.name, row.githubInstallationId);
      }
      else await this.verifyGitLab(row.projectId, row.owner, row.name);
      checked = result(true, null);
    } catch (error) {
      if (!(error instanceof RepoCheckException)) throw error;
      checked = result(false, error.reason);
    }
    return async () => {
      const current = await this.repo.findById(id);
      if (!isDeepStrictEqual(current, row)) throw new ConflictAppException({}, 'fleet.repos');
      return checked;
    };
  }
}
