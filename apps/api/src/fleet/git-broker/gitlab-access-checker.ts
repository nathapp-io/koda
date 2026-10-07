import { Inject, Injectable } from '@nestjs/common';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { FleetHttpClient } from './fleet-http-client';
import type { CanonicalRepo } from './github-app-client';
import { RepoCheckException } from './repo-check.exception';
import type { VcsPrStatus } from '../../vcs/types';
import type { ForgeFile, ForgeTreeEntry } from './forge-tree';

const DEVELOPER = 30;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
const level = (v: unknown): number => {
  const n = obj(v).access_level;
  return typeof n === 'number' ? n : 0;
};

@Injectable()
export class GitLabAccessChecker {
  constructor(
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'gitlabApiUrl'>,
    private readonly http: FleetHttpClient,
  ) {}

  async commentOnMergeRequest(owner: string, name: string, iid: number, body: string, token: string): Promise<boolean> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const res = await this.http.request('POST', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests/${iid}/notes`, { 'private-token': token }, { body });
    return res.status === 201;
  }

  /** Fleet C9 §3.4: one MR's state with the project's GitLab token. Null when the MR does not exist. */
  async getMergeRequest(token: string, owner: string, name: string, iid: number): Promise<VcsPrStatus | null> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const res = await this.http.request('GET', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests/${iid}`, { 'private-token': token });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.state !== 'string' || typeof b.web_url !== 'string') throw new RepoCheckException('provider_error');
    const mergedBy = obj(b.merged_by).username;
    const sha = typeof b.merge_commit_sha === 'string' ? b.merge_commit_sha : typeof b.squash_commit_sha === 'string' ? b.squash_commit_sha : null;
    return {
      number: iid,
      state: b.state === 'opened' || b.state === 'locked' ? 'open' : 'closed',
      draft: b.draft === true || b.work_in_progress === true,
      merged: b.state === 'merged',
      mergedAt: typeof b.merged_at === 'string' ? new Date(b.merged_at) : null,
      mergedBy: typeof mergedBy === 'string' ? mergedBy : null,
      mergeSha: sha,
      url: b.web_url,
      title: typeof b.title === 'string' ? b.title : '',
    };
  }

  private project(owner: string, name: string): string {
    return `${this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '')}/projects/${encodeURIComponent(`${owner}/${name}`)}`;
  }

  /** Fleet S3 §4.1: the commit a branch points at. */
  async getBranchHead(token: string, owner: string, name: string, branch: string): Promise<string> {
    const res = await this.http.request('GET', `${this.project(owner, name)}/repository/branches/${encodeURIComponent(branch)}`, { 'private-token': token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const id = obj(obj(res.body).commit).id;
    if (typeof id !== 'string') throw new RepoCheckException('provider_error');
    return id;
  }

  static readonly TREE_PAGE = 100;
  static readonly TREE_MAX_PAGES = 10;

  /**
   * Fleet S3 §4.1: recursive tree under `path` at `ref`. FleetHttpClient exposes no headers, so paging stops at the first short
   * page; more than TREE_MAX_PAGES full pages is refused (a `.nax/` that large is not a config dir).
   */
  async listTree(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeTreeEntry[]> {
    const out: ForgeTreeEntry[] = [];
    for (let page = 1; page <= GitLabAccessChecker.TREE_MAX_PAGES; page += 1) {
      const query = `path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${GitLabAccessChecker.TREE_PAGE}&page=${page}`;
      const res = await this.http.request('GET', `${this.project(owner, name)}/repository/tree?${query}`, { 'private-token': token });
      if (res.status === 404) return [];
      if (res.status !== 200 || !Array.isArray(res.body)) throw new RepoCheckException('provider_error');
      for (const raw of res.body) {
        const e = obj(raw);
        if ((e.type === 'blob' || e.type === 'tree') && typeof e.path === 'string' && typeof e.id === 'string') {
          out.push({ path: e.path, type: e.type, sha: e.id, size: null });
        }
      }
      if (res.body.length < GitLabAccessChecker.TREE_PAGE) return out;
    }
    throw new RepoCheckException('provider_error');
  }

  /** Fleet S3 §4.1: one file at a ref (files API, base64). Null when absent. */
  async getFile(token: string, owner: string, name: string, path: string, ref: string): Promise<ForgeFile | null> {
    const res = await this.http.request('GET', `${this.project(owner, name)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { 'private-token': token });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new RepoCheckException('provider_error');
    const b = obj(res.body);
    if (typeof b.blob_id !== 'string' || typeof b.size !== 'number' || b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { sha: b.blob_id, size: b.size, content: Buffer.from(b.content, 'base64') };
  }

  async verifyRepo(owner: string, name: string, token: string): Promise<CanonicalRepo> {
    const api = this.vcsConfig.gitlabApiUrl.replace(/\/+$/, '');
    const headers = { 'private-token': token };

    const self = await this.http.request('GET', `${api}/personal_access_tokens/self`, headers);
    if ([401, 403, 404].includes(self.status)) throw new RepoCheckException('gitlab_token_invalid');
    if (self.status !== 200) throw new RepoCheckException('provider_error');
    const scopes = obj(self.body).scopes;
    if (!Array.isArray(scopes) || !scopes.includes('write_repository')) throw new RepoCheckException('gitlab_scope_missing');

    const project = await this.http.request('GET', `${api}/projects/${encodeURIComponent(`${owner}/${name}`)}`, headers);
    if (project.status === 404) throw new RepoCheckException('repo_not_found');
    if (project.status !== 200) throw new RepoCheckException('provider_error');
    const body = obj(project.body);
    const permissions = obj(body.permissions);
    if (Math.max(level(permissions.project_access), level(permissions.group_access)) < DEVELOPER) {
      throw new RepoCheckException('gitlab_access_insufficient');
    }
    const path = body.path_with_namespace;
    if (typeof path !== 'string' || typeof body.default_branch !== 'string' || !path.includes('/')) {
      throw new RepoCheckException('provider_error');
    }
    const cut = path.lastIndexOf('/');
    return { owner: path.slice(0, cut), name: path.slice(cut + 1), defaultBranch: body.default_branch };
  }
}
