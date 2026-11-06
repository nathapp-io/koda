import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { GitToken, GitTokenError } from '../common/protocol';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { GitHubAppClient } from './github-app-client';
import { GitLabTokenSource } from './gitlab-token.source';
import { RepoCheckException } from './repo-check.exception';

export type MintResult = { ok: true; token: GitToken } | { ok: false; error: GitTokenError };

/**
 * US-005: a mint's purpose. `review` and `fix` are the PR-job credentials; `read` is the AGENT job's read-only
 * default-repository credential, which is cached under its own key so it can never answer a write request.
 */
export type GitTokenPurpose = 'review' | 'fix' | 'read';

/** The broker's request shape; `readOnly` (the PROJECT per-repository grant) is not a purpose. */
export interface MintRequest {
  jobId: string;
  leaseEpoch: number;
  repo: FleetRepoRef;
  readOnly?: boolean;
  purpose?: GitTokenPurpose;
  fresh?: boolean;
}

/**
 * US-005: each purpose owns its cache entry, so a read credential can never answer a write request (or the other
 * way round). A purpose-less per-repository read-only mint keys on the repository; the default mint on the job+epoch.
 */
const cacheKey = (req: Pick<MintRequest, 'jobId' | 'leaseEpoch' | 'repo' | 'purpose'>, readOnly: boolean): string => {
  const scope = `${req.jobId}:${req.leaseEpoch}`;
  if (req.purpose === 'review' || req.purpose === 'read') return `${scope}:${req.purpose}`;
  return readOnly ? `${scope}:ro:${req.repo.id}` : scope;
};

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
   *
   * US-005: `purpose: 'read'` is the AGENT credential — a GitHub read-only token with NO `repoId`, cached under
   * `<jobId>:<leaseEpoch>:read`, so the runner matches it to the job's default (repo-less) token request. The two
   * are deliberately distinct: `readOnly` names a repository, `purpose: 'read'` never does.
   */
  async mint(req: MintRequest, now = new Date()): Promise<MintResult> {
    // FIX always requires a write-capable result; readOnly remains meaningful for purpose-less PROJECT mints.
    // `purpose: 'read'` is repo-less by definition, so it is never treated as a per-repository read-only mint.
    const readOnly = req.readOnly === true && req.purpose !== 'fix' && req.purpose !== 'read';
    // Purpose credentials are GitHub-only; reject before cache lookup so a legacy/write entry cannot bypass this.
    if (req.purpose && req.repo.provider !== 'github') {
      return { ok: false, error: { jobId: req.jobId, reason: 'provider_error' } };
    }
    const key = cacheKey(req, readOnly);
    const cached = this.cache.get(key);
    const reuseMarginMs = this.fleetConfig.gitTokenReuseMarginSec * 1000;
    if (!req.fresh && cached && Date.parse(cached.expiresAt) - now.getTime() > reuseMarginMs) return { ok: true, token: cached };
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

  private async fresh(req: MintRequest, now: Date): Promise<GitToken> {
    const { repo, purpose } = req;
    // `purpose: 'read'` is not `readOnly`: it names no repository and is answered by its own branch below.
    const readOnly = req.readOnly === true && purpose !== 'fix' && purpose !== 'read';
    if (repo.provider === 'github') {
      if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
      if (purpose === 'review') {
        const { token, expiresAt } = await this.github.mintReviewToken(repo.githubInstallationId, repo.name);
        return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString() };
      }
      // US-005: the AGENT credential — read-only, GitHub only, and deliberately carries no `repoId`, because the
      // runner matches it to the job's default (repo-less) token request rather than a per-repository one.
      if (purpose === 'read') {
        const { token, expiresAt } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
        return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString() };
      }
      // A repo-level, audited override (fixAllowUnprotected) skips the protection check for FIX only.
      if (purpose === 'fix' && repo.fixAllowUnprotected !== true) {
        const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
        if (!await this.github.isBranchProtected(token, repo.owner, repo.name, repo.defaultBranch)) {
          throw new RepoCheckException('default_branch_unprotected');
        }
      }
      const { token, expiresAt } = readOnly
        ? await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name)
        : await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      return { jobId: req.jobId, token, username: 'x-access-token', expiresAt: expiresAt.toISOString(), ...(readOnly ? { repoId: repo.id } : {}) };
    }
    // Purpose and read-only requests must never fall back to the write-capable stored GitLab token.
    if (purpose || readOnly) throw new RepoCheckException('provider_error');
    const token = await this.gitlab.resolve(repo.projectId, repo.owner, repo.name);
    return { jobId: req.jobId, token, username: 'oauth2', expiresAt: new Date(now.getTime() + this.fleetConfig.gitlabTokenTtlSec * 1000).toISOString() };
  }
}
