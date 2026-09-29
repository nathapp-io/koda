import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { GitToken, GitTokenError } from '../common/protocol';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { GitHubAppClient } from './github-app-client';
import { GitLabTokenSource } from './gitlab-token.source';
import { RepoCheckException } from './repo-check.exception';

export type MintResult = { ok: true; token: GitToken } | { ok: false; error: GitTokenError };

/**
 * Per-job git credentials (spec §7.1, §6.3). Callers fence first: only the job's current
 * (runnerId, leaseEpoch) in ASSIGNED | RUNNING | UPLOADING reaches mint(). Tokens live only
 * in this in-memory cache and the sync response; never logged, never stored.
 *
 * Tunables live on IFleetConfig: `gitTokenReuseMarginSec` (cached GitHub App token reuse
 * window), `gitlabTokenTtlSec` (defensive TTL on the GitLab stored token).
 */
@Injectable()
export class GitTokenBroker {
  private readonly logger = new Logger(GitTokenBroker.name);
  private cache: ReadonlyMap<string, GitToken> = new Map();

  constructor(
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'gitTokenReuseMarginSec' | 'gitlabTokenTtlSec'>,
    @Inject(forwardRef(() => GitHubAppClient)) private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabTokenSource,
  ) {}

  async mint(req: { jobId: string; leaseEpoch: number; repo: FleetRepoRef }, now = new Date()): Promise<MintResult> {
    const key = `${req.jobId}:${req.leaseEpoch}`;
    const cached = this.cache.get(key);
    const reuseMarginMs = this.fleetConfig.gitTokenReuseMarginSec * 1000;
    if (cached && Date.parse(cached.expiresAt) - now.getTime() > reuseMarginMs) return { ok: true, token: cached };
    try {
      const token = await this.fresh(req, now);
      this.cache = new Map([...[...this.cache].filter(([, t]) => Date.parse(t.expiresAt) > now.getTime()), [key, token]]);
      return { ok: true, token };
    } catch (error) {
      if (error instanceof RepoCheckException) return { ok: false, error: { jobId: req.jobId, reason: error.reason } };
      // Never log the error message: a provider body could echo a credential.
      this.logger.error(`Git token mint failed for job ${req.jobId} (${error instanceof Error ? error.name : 'unknown'})`);
      return { ok: false, error: { jobId: req.jobId, reason: 'provider_error' } };
    }
  }

  evict(jobId: string): void {
    this.cache = new Map([...this.cache].filter(([key]) => !key.startsWith(`${jobId}:`)));
  }

  private async fresh(req: { jobId: string; repo: FleetRepoRef }, now: Date): Promise<GitToken> {
    const { repo } = req;
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      const { token, expiresAt } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString() };
    }
    const token = await this.gitlab.resolve(repo.projectId, repo.owner, repo.name);
    return { jobId: req.jobId, token, username: 'oauth2', expiresAt: new Date(now.getTime() + this.fleetConfig.gitlabTokenTtlSec * 1000).toISOString() };
  }
}
