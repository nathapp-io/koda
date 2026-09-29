import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { FLEET_CFG, IFleetConfig, isGitHubAppConfigured } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FleetHttpClient } from './fleet-http-client';
import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException, RepoCheckReason } from './repo-check.exception';

export interface CanonicalRepo {
  owner: string;
  name: string;
  defaultBranch: string;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});

@Injectable()
export class GitHubAppClient {
  private privateKey: string | undefined;

  constructor(
    @Inject(FLEET_CFG) private readonly fleetConfig: IFleetConfig,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'githubApiUrl'>,
    private readonly http: FleetHttpClient,
    @Inject(forwardRef(() => GitTokenBroker)) private readonly broker: GitTokenBroker,
  ) {}

  private get api(): string {
    return this.vcsConfig.githubApiUrl.replace(/\/+$/, '');
  }

  private headers(bearer: string): Record<string, string> {
    return { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  }

  /** RS256 App JWT: iat 60s in the past for clock skew, 9 min lifetime (GitHub max is 10). */
  createAppJwt(now: Date = new Date()): string {
    if (!isGitHubAppConfigured(this.fleetConfig)) throw new RepoCheckException('github_app_not_configured');
    try {
      this.privateKey ??= readFileSync(this.fleetConfig.githubAppPrivateKeyFile as string, 'utf8');
      const iat = Math.floor(now.getTime() / 1000) - 60;
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: this.fleetConfig.githubAppId }));
      const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(this.privateKey);
      return `${header}.${payload}.${b64url(signature)}`;
    } catch (error) {
      if (error instanceof RepoCheckException) throw error;
      // A set-but-broken key path (ENOENT/EACCES) or unparseable PEM is a setup fault the
      // operator must see as a 422 with a fixed reason, not a raw 500 (spec §7.1).
      throw new RepoCheckException('github_app_key_unreadable');
    }
  }

  /** Repo-scoped installation token (spec §7.1): contents + pull_requests write, metadata read. */
  async mintInstallationToken(installationId: bigint, repoName: string): Promise<{ token: string; expiresAt: Date }> {
    const minted = await this.http.request('POST', `${this.api}/app/installations/${installationId.toString()}/access_tokens`, this.headers(this.createAppJwt()), {
      repositories: [repoName],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    if (minted.status === 404) throw new RepoCheckException('app_not_installed');
    if (minted.status === 422 || minted.status === 403) throw new RepoCheckException('app_permissions_insufficient');
    if (minted.status !== 201) throw new RepoCheckException('provider_error');
    const { token, expires_at: expiresAt } = obj(minted.body);
    if (typeof token !== 'string' || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) throw new RepoCheckException('provider_error');
    return { token, expiresAt: new Date(expiresAt) };
  }

  /**
   * Spec §7.1 attribution: one issue comment on the PR. When `opts.jobId/leaseEpoch/repo`
   * are all provided, prefer the in-memory `GitTokenBroker` cache (the same token the
   * runner is using for the job); this saves one App mint per attributed job. The
   * verification path calls without `opts` and gets a fresh mint.
   */
  async commentOnPullRequest(
    installationId: bigint,
    owner: string,
    name: string,
    number: number,
    body: string,
    opts?: { jobId?: string; leaseEpoch?: number; repo?: FleetRepoRef },
  ): Promise<boolean> {
    let token: string;
    if (opts?.jobId && opts.leaseEpoch !== undefined && opts.repo) {
      const result = await this.broker.mint({ jobId: opts.jobId, leaseEpoch: opts.leaseEpoch, repo: opts.repo }, new Date());
      if (result.ok === false) throw new RepoCheckException(result.error.reason as RepoCheckReason);
      token = result.token.token;
    } else {
      const minted = await this.mintInstallationToken(installationId, name);
      token = minted.token;
    }
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`;
    const res = await this.http.request('POST', `${this.api}${path}`, this.headers(token), { body });
    return res.status === 201;
  }

  async verifyRepo(owner: string, name: string): Promise<CanonicalRepo & { installationId: bigint }> {
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    const appJwt = this.createAppJwt();

    const installation = await this.http.request('GET', `${this.api}${repoPath}/installation`, this.headers(appJwt));
    if (installation.status === 404) throw new RepoCheckException('app_not_installed');
    if (installation.status !== 200) throw new RepoCheckException('provider_error');
    const installationId = obj(installation.body).id;
    if (typeof installationId !== 'number') throw new RepoCheckException('provider_error');

    const { token } = await this.mintInstallationToken(BigInt(installationId), name);

    const repo = await this.http.request('GET', `${this.api}${repoPath}`, this.headers(token));
    if (repo.status === 404) throw new RepoCheckException('repo_not_found');
    if (repo.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(repo.body);
    const login = obj(body.owner).login;
    if (typeof login !== 'string' || typeof body.name !== 'string' || typeof body.default_branch !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { owner: login, name: body.name, defaultBranch: body.default_branch, installationId: BigInt(installationId) };
  }
}
