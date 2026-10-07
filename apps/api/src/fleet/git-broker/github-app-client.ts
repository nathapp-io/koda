import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { FLEET_CFG, IFleetConfig, isGitHubAppConfigured } from '../../config/fleet.config';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FleetHttpClient } from './fleet-http-client';
import { GitTokenBroker } from './git-token.broker';
import { RepoCheckException, RepoCheckReason } from './repo-check.exception';
import type { VcsPrStatus } from '../../vcs/types';
import type { ForgeFile, ForgeTreeEntry } from './forge-tree';

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

  /**
   * Fleet C9 §3.4: one PR's state, read with a repo-scoped installation token the caller minted
   * (one mint per repo per refresh pass, plan P1). Null when the PR does not exist.
   */
  async getPullRequest(token: string, owner: string, name: string, number: number): Promise<VcsPrStatus | null> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}`;
    const res = await this.http.request('GET', `${this.api}${path}`, this.headers(token));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.state !== 'string' || typeof b.html_url !== 'string') throw new RepoCheckException('provider_error');
    const mergedBy = obj(b.merged_by).login;
    return {
      number,
      state: b.state,
      draft: b.draft === true,
      merged: b.merged === true,
      mergedAt: typeof b.merged_at === 'string' ? new Date(b.merged_at) : null,
      mergedBy: typeof mergedBy === 'string' ? mergedBy : null,
      mergeSha: typeof b.merge_commit_sha === 'string' ? b.merge_commit_sha : null,
      url: b.html_url,
      title: typeof b.title === 'string' ? b.title : '',
    };
  }

  private repoPath(owner: string, name: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** Fleet S3 §4.1: the commit a branch points at. */
  async getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string> {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/git/ref/heads/${ref}`, this.headers(token));
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const sha = obj(obj(res.body).object).sha;
    if (typeof sha !== 'string') throw new RepoCheckException('provider_error');
    return sha;
  }

  /** Fleet S3 §4.1: a tree by commit or tree SHA. Entries other than blob/tree (submodules) are dropped. */
  async getTree(token: string, owner: string, name: string, treeish: string, recursive: boolean): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean }> {
    const query = recursive ? '?recursive=1' : '';
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/git/trees/${encodeURIComponent(treeish)}${query}`, this.headers(token));
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(res.body);
    if (!Array.isArray(body.tree)) throw new RepoCheckException('provider_error');
    const entries = body.tree.flatMap((raw): ForgeTreeEntry[] => {
      const e = obj(raw);
      if ((e.type !== 'blob' && e.type !== 'tree') || typeof e.path !== 'string' || typeof e.sha !== 'string') return [];
      return [{ path: e.path, type: e.type, sha: e.sha, size: typeof e.size === 'number' ? e.size : null }];
    });
    return { entries, truncated: body.truncated === true };
  }

  /** Fleet S3 §4.1: one file at a ref (contents API, base64). Null when absent or not a file. */
  async getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.http.request('GET', `${this.api}${this.repoPath(owner, name)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, this.headers(token));
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (b.type !== 'file') return null;
    if (typeof b.sha !== 'string' || typeof b.size !== 'number' || b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { sha: b.sha, size: b.size, content: Buffer.from(b.content, 'base64') };
  }

  async verifyRepo(owner: string, name: string, persistedInstallationId?: bigint): Promise<CanonicalRepo & { installationId: bigint }> {
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    let installationId = persistedInstallationId;
    if (installationId === undefined) {
      const installation = await this.http.request('GET', `${this.api}${repoPath}/installation`, this.headers(this.createAppJwt()));
      if (installation.status === 404) throw new RepoCheckException('app_not_installed');
      if (installation.status !== 200) throw new RepoCheckException('provider_error');
      const discoveredId = obj(installation.body).id;
      if (typeof discoveredId !== 'number') throw new RepoCheckException('provider_error');
      installationId = BigInt(discoveredId);
    }

    const { token } = await this.mintInstallationToken(installationId, name);

    const repo = await this.http.request('GET', `${this.api}${repoPath}`, this.headers(token));
    if (repo.status === 404) throw new RepoCheckException('repo_not_found');
    if (repo.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(repo.body);
    const login = obj(body.owner).login;
    if (typeof login !== 'string' || typeof body.name !== 'string' || typeof body.default_branch !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { owner: login, name: body.name, defaultBranch: body.default_branch, installationId };
  }
}
