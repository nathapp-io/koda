import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { GitToken, GitTokenError } from '../common/protocol';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { GitHubAppClient } from './github-app-client';
import { GitLabRepoCredentials } from './gitlab-repo-credentials';
import { GitLabAccessChecker } from './gitlab-access-checker';
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
 * How many times the GitLab FIX gate may run. The gate's answer is bound to the credential it checked,
 * so a rotation between the check and the issuance runs the gate again against the new credential; a
 * credential that keeps moving is refused instead of being granted unchecked.
 */
const GITLAB_FIX_GATE_ATTEMPTS = 3;

/**
 * One cached credential: the token a runner may hold and the repo it was minted for. US-003: the
 * repo id is what lets a rotated credential drop the tokens cached under it.
 */
interface CachedToken {
  token: GitToken;
  repoId: string;
}

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
  private cache: ReadonlyMap<string, CachedToken> = new Map();
  /**
   * The generation of one repo's cached tokens. `evictRepo` moves the generation, so a mint that was
   * already awaiting the credential when the eviction happened cannot write its token back into the
   * cache: the rotation that evicted it may have replaced the very credential the mint read.
   *
   * One small number per repo that was ever evicted — the fleet's repos are admin-created, so this
   * map holds as many entries as the deployment has repos.
   */
  private readonly generations = new Map<string, number>();

  constructor(
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'gitTokenReuseMarginSec' | 'gitlabTokenTtlSec'>,
    @Inject(forwardRef(() => GitHubAppClient)) private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabRepoCredentials,
    private readonly gitlabChecker: GitLabAccessChecker,
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
    const readOnly = req.readOnly === true && req.purpose === undefined;
    const key = cacheKey(req, readOnly);
    const cached = this.cache.get(key);
    const reuseMarginMs = this.fleetConfig.gitTokenReuseMarginSec * 1000;
    if (!req.fresh && cached && Date.parse(cached.token.expiresAt) - now.getTime() > reuseMarginMs) return { ok: true, token: cached.token };
    // The repo's generation is read before the mint awaits the credential: an eviction that happens
    // meanwhile moves it, and the token this mint reads is then never cached.
    const generation = this.generationOf(req.repo.id);
    try {
      const token = await this.fresh(req, now);
      // A rotation evicted the repo while this mint was in flight: the token may be the credential
      // the rotation replaced, so it is answered to its caller but never kept for the next mint.
      if (this.generationOf(req.repo.id) === generation) {
        this.cache = new Map([...[...this.cache].filter(([, entry]) => Date.parse(entry.token.expiresAt) > now.getTime()), [key, { token, repoId: req.repo.id }]]);
      }
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

  /**
   * US-003: drops every cached token minted for one repo, whatever job holds it. A rotated
   * credential is answered by the next mint, never by a token cached under the old one.
   *
   * The repo's generation moves with it, so a mint that is already awaiting the credential cannot
   * write that credential back into the cache after the eviction.
   */
  evictRepo(repoId: string): void {
    this.generations.set(repoId, this.generationOf(repoId) + 1);
    this.cache = new Map([...this.cache].filter(([, entry]) => entry.repoId !== repoId));
  }

  /** The generation a repo's cached tokens belong to. */
  private generationOf(repoId: string): number {
    return this.generations.get(repoId) ?? 0;
  }

  private async fresh(req: MintRequest, now: Date): Promise<GitToken> {
    const { repo, purpose } = req;
    // `purpose: 'read'` is not `readOnly`: it names no repository and is answered by its own branch below.
    const readOnly = req.readOnly === true && purpose === undefined;
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
    const write = purpose !== 'read' && !readOnly;
    if (purpose === 'fix' && repo.fixAllowUnprotected !== true) {
      // GitLab reports whether this token's own user can push, incorporating inherited and wildcard rules.
      // The grant is bound to the credential the check ran with, so a rotation between the check and the
      // issuance repeats the check instead of handing out a credential that was never checked.
      return this.gitlabFixGrant(req, now);
    }
    // Stored repo credentials are purpose-specific. The FIX gate above issues its own grant; every other
    // mint resolves the credential its purpose names.
    const { token } = await this.gitlab.resolve(repo, write ? 'write' : 'read');
    return {
      jobId: req.jobId,
      token,
      username: 'oauth2',
      expiresAt: new Date(now.getTime() + this.fleetConfig.gitlabTokenTtlSec * 1000).toISOString(),
      ...(readOnly ? { repoId: repo.id } : {}),
    };
  }

  /**
   * The write token a GitLab FIX mint issues, after the default-branch gate.
   *
   * The gate asks GitLab whether the credential's own user can push to the default branch, so the token
   * handed to the runner must be the one that was checked. A rotation between the check and the issuance
   * moves the stored credential: the check is then repeated against the new one, and a credential that
   * keeps moving is refused rather than granted unchecked.
   */
  private async gitlabFixGrant(req: MintRequest, now: Date): Promise<GitToken> {
    const { repo } = req;
    for (let attempt = 0; attempt < GITLAB_FIX_GATE_ATTEMPTS; attempt += 1) {
      const checked = await this.gitlab.call(repo, 'write', async (access) => {
        const state = await this.gitlabChecker.getBranchPushState(access, repo.defaultBranch);
        if (!state.protected || state.canPush) throw new RepoCheckException('default_branch_unprotected');
        return access.token;
      });
      // The stored credential is read again: it is the one that would be issued, so a rotation that
      // happened during the check is visible here.
      const current = await this.gitlab.resolve(repo, 'write');
      if (current.token === checked) {
        return {
          jobId: req.jobId,
          token: current.token,
          username: 'oauth2',
          expiresAt: new Date(now.getTime() + this.fleetConfig.gitlabTokenTtlSec * 1000).toISOString(),
        };
      }
      // The credential moved under the check: run the gate again against the new one.
    }
    throw new RepoCheckException('provider_error');
  }
}
