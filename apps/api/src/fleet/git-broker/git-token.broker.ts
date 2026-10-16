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

  /**
   * Fleet S5b 1c-b-D4: `readOnly: true` mints one project repository's read-only token for a PROJECT session.
   * It is cached under its own key (per job, epoch and repository), and its result carries the `repoId` so the
   * runner can tell which repository a token belongs to. Write mints are unchanged.
   */
  async mint(req: { jobId: string; leaseEpoch: number; repo: FleetRepoRef; readOnly?: boolean }, now = new Date()): Promise<MintResult> {
    const readOnly = req.readOnly === true;
    const key = readOnly ? `${req.jobId}:${req.leaseEpoch}:ro:${req.repo.id}` : `${req.jobId}:${req.leaseEpoch}`;
    const cached = this.cache.get(key);
    const reuseMarginMs = this.fleetConfig.gitTokenReuseMarginSec * 1000;
    if (cached && Date.parse(cached.expiresAt) - now.getTime() > reuseMarginMs) return { ok: true, token: cached };
    try {
      const token = await this.fresh(req, now);
      this.cache = new Map([...[...this.cache].filter(([, t]) => Date.parse(t.expiresAt) > now.getTime()), [key, token]]);
      return { ok: true, token };
    } catch (error) {
      // Only a read-only mint is per repository, so only it names one on the error.
      const withRepoId = readOnly ? { repoId: req.repo.id } : {};
      if (error instanceof RepoCheckException) return { ok: false, error: { jobId: req.jobId, reason: error.reason, ...withRepoId } };
      // Never log the error message: a provider body could echo a credential.
      this.logger.error(`Git token mint failed for job ${req.jobId} (${error instanceof Error ? error.name : 'unknown'})`);
      return { ok: false, error: { jobId: req.jobId, reason: 'provider_error', ...withRepoId } };
    }
  }

  evict(jobId: string): void {
    this.cache = new Map([...this.cache].filter(([key]) => !key.startsWith(`${jobId}:`)));
  }

  private async fresh(req: { jobId: string; repo: FleetRepoRef; readOnly?: boolean }, now: Date): Promise<GitToken> {
    const { repo, readOnly } = req;
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      const { token, expiresAt } = readOnly
        ? await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name)
        : await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString(), ...(readOnly ? { repoId: repo.id } : {}) };
    }
    // Fleet S5b defers read-only GitLab access (spec §1c-b-R2): never fall back to the write-capable stored token.
    if (readOnly) throw new RepoCheckException('provider_error');
    const token = await this.gitlab.resolve(repo.projectId, repo.owner, repo.name);
    return { jobId: req.jobId, token, username: 'oauth2', expiresAt: new Date(now.getTime() + this.fleetConfig.gitlabTokenTtlSec * 1000).toISOString() };
  }
}
