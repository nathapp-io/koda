import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IVcsRepository, VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import { mapPrState } from '../../vcs/pr-state';
import type { VcsPrStatus } from '../../vcs/types';
import { VcsPrSyncService } from '../../vcs/vcs-pr-sync.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';
import type { RefreshableLink, RefreshRepo } from './prisma-fleet-tickets.repository';

export interface RefreshSummary {
  skipped: boolean;
  checked: number;
  changed: number;
  failedRepos: number;
}

type ReadPr = (number: number) => Promise<VcsPrStatus | null>;

const errorName = (error: unknown): string =>
  error instanceof RepoCheckException ? error.reason : error instanceof Error ? error.name : 'unknown';

/**
 * Fleet C9 §3.4 (D456): keeps fleet PR links current without a VcsConnection, through the
 * koda-fleet GitHub App or the project's GitLab token. In process (single API instance), like
 * FleetSweeper; one pass at a time; never throws.
 */
@Injectable()
export class FleetPrStateRefresher implements OnModuleInit, OnModuleDestroy {
  static readonly BATCH = 500; // plan P5

  private readonly logger = new Logger(FleetPrStateRefresher.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repo: PrismaFleetTicketsRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'updateTicketLinkWithPrState'>,
    private readonly prSync: VcsPrSyncService,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'sweepEnabled' | 'prRefreshMs'>,
  ) {}

  onModuleInit(): void {
    if (!this.config.sweepEnabled) return; // plan P3
    this.timer = setInterval(() => void this.refresh(), this.config.prRefreshMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<RefreshSummary> {
    if (this.running) return { skipped: true, checked: 0, changed: 0, failedRepos: 0 };
    this.running = true;
    const summary: RefreshSummary = { skipped: false, checked: 0, changed: 0, failedRepos: 0 };
    try {
      const byRepo = new Map<string, RefreshableLink[]>();
      for (const link of await this.repo.findRefreshableFleetLinks(FleetPrStateRefresher.BATCH)) {
        byRepo.set(link.repo.id, [...(byRepo.get(link.repo.id) ?? []), link]);
      }
      for (const links of byRepo.values()) {
        const counts = await this.refreshRepo(links);
        if (counts === null) summary.failedRepos += 1;
        else {
          summary.checked += counts.checked;
          summary.changed += counts.changed;
        }
      }
    } catch (error) {
      this.logger.warn(`Fleet PR refresh failed: ${errorName(error)}`);
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Null when the repo could not be read at all (token or install missing). */
  private async refreshRepo(links: readonly RefreshableLink[]): Promise<{ checked: number; changed: number } | null> {
    const repo = links[0].repo;
    let read: ReadPr;
    try {
      read = await this.readerFor(repo);
    } catch (error) {
      this.logger.warn(`Fleet PR refresh: ${repo.owner}/${repo.name} skipped (${errorName(error)})`);
      return null;
    }
    let checked = 0;
    let changed = 0;
    for (const link of links) {
      try {
        const pr = await read(link.prNumber);
        checked += 1;
        if (await this.apply(link, pr)) changed += 1;
      } catch (error) {
        this.logger.debug(`Fleet PR refresh: link ${link.id} skipped (${errorName(error)})`);
      }
    }
    return { checked, changed };
  }

  private async readerFor(repo: RefreshRepo): Promise<ReadPr> {
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      const { token } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return (number) => this.github.getPullRequest(token, repo.owner, repo.name, number);
    }
    const token = await this.gitlabTokens.resolve(repo.projectId, repo.owner, repo.name);
    return (number) => this.gitlab.getMergeRequest(token, repo.owner, repo.name, number);
  }

  /** True when this pass changed the link. A deleted PR (null) becomes closed, like the VCS poll's 404. */
  private async apply(link: RefreshableLink, pr: VcsPrStatus | null): Promise<boolean> {
    const next = pr === null ? 'closed' : mapPrState(pr);
    if (next === link.prState) return false;
    const outcome = pr !== null && next === 'merged'
      ? await this.prSync.applyMergedPr(link, pr)
      : await this.vcsRepo.updateTicketLinkWithPrState(link.id, next);
    return outcome === 'updated';
  }
}
