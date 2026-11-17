import { Injectable } from '@nestjs/common';
import { FleetHttpClient } from './fleet-http-client';
import type { GitLabAccess } from './gitlab-repo-credentials';
import { assertGitLabHostAllowed } from './gitlab-host';
import { RepoCheckException } from './repo-check.exception';
import type { VcsPrStatus } from '../../vcs/types';
import type { OpenPullRequest } from './github-app-client';
import type { ForgeFile, ForgeTreeEntry } from './forge-tree';

/** The GitLab access level a fleet job needs: Developer or above. */
export const GITLAB_DEVELOPER_ACCESS = 30;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null ? (v as Obj) : {});
/** The access level of one `project_access` / `group_access` entry; 0 when it carries none. */
const level = (v: unknown): number => {
  const n = obj(v).access_level;
  return typeof n === 'number' ? n : 0;
};

/**
 * US-002 (GitLab parity F1): the GitLab API client of the fleet.
 *
 * Every call is addressed by an access: the token to present and the target to address — the repo's
 * own api base and its numeric GitLab project id, never an owner/name pair, because two hosts can
 * hold the same path. Every request passes the host check first, so a repo row can never make koda
 * talk to an address inside the deployment.
 */
@Injectable()
export class GitLabAccessChecker {
  constructor(private readonly http: FleetHttpClient) {}

  /** The project url of an access: the api base plus the numeric project id. */
  private projectUrl(access: GitLabAccess): string {
    return `${trimSlashes(access.target.apiBase)}/projects/${access.target.projectId}`;
  }

  /** The host check every request passes before it leaves the process. */
  private async guard(target: string): Promise<void> {
    await assertGitLabHostAllowed(target);
  }

  /**
   * The shared status mapping: 401 is an invalid token, 403 is not enough permission, and anything
   * else is a fault of the provider. The caller keeps the meaning of its own 404.
   */
  private fail(status: number): never {
    if (status === 401) throw new RepoCheckException('gitlab_token_invalid');
    if (status === 403) throw new RepoCheckException('app_permissions_insufficient');
    throw new RepoCheckException('provider_error');
  }

  /** Posts a note on a merge request. False when the merge request is gone or the note was refused. */
  async commentOnMergeRequest(access: GitLabAccess, iid: number, body: string): Promise<boolean> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('POST', `${this.projectUrl(access)}/merge_requests/${iid}/notes`, { 'private-token': access.token }, { body });
    if (res.status === 201) return true;
    if (res.status === 404) return false;
    this.fail(res.status);
  }

  /** Fleet C9 §3.4: one MR's state with the project's GitLab token. Null when the MR does not exist. */
  async getMergeRequest(access: GitLabAccess, iid: number): Promise<VcsPrStatus | null> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/merge_requests/${iid}`, { 'private-token': access.token });
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res.status);
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
      ...(typeof b.sha === 'string' ? { headSha: b.sha } : {}),
      url: b.web_url,
      title: typeof b.title === 'string' ? b.title : '',
    };
  }

  /** Lists the first page of open merge requests in the target project. */
  async listOpenMergeRequests(access: GitLabAccess, fullName: string): Promise<OpenPullRequest[]> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/merge_requests?state=opened&per_page=100`, { 'private-token': access.token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    if (!Array.isArray(res.body)) throw new RepoCheckException('provider_error');
    const prs: OpenPullRequest[] = [];
    for (const raw of res.body) {
      const item = obj(raw);
      const sha = item.sha;
      if (typeof item.iid !== 'number' || typeof item.updated_at !== 'string' || (sha !== null && typeof sha !== 'string')) {
        throw new RepoCheckException('provider_error');
      }
      if (sha === null) continue;
      if (typeof sha !== 'string') throw new RepoCheckException('provider_error');
      const updatedAt = new Date(item.updated_at);
      if (Number.isNaN(updatedAt.getTime())) throw new RepoCheckException('provider_error');
      prs.push({
        number: item.iid,
        headSha: sha,
        draft: item.draft === true || item.work_in_progress === true,
        headRepoFullName: item.source_project_id === access.target.projectId ? fullName : null,
        updatedAt,
      });
    }
    return prs;
  }

  /** The branch protection state and whether this access token's user can push to the branch. */
  async getBranchPushState(access: GitLabAccess, branch: string): Promise<{ protected: boolean; canPush: boolean }> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/repository/branches/${encodeURIComponent(branch)}`, { 'private-token': access.token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    const body = obj(res.body);
    if (typeof body.protected !== 'boolean' || typeof body.can_push !== 'boolean') throw new RepoCheckException('provider_error');
    return { protected: body.protected, canPush: body.can_push };
  }

  /** Fleet S3 §4.1: the commit a branch points at. */
  async getBranchHead(access: GitLabAccess, branch: string): Promise<string> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/repository/branches/${encodeURIComponent(branch)}`, { 'private-token': access.token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    const id = obj(obj(res.body).commit).id;
    if (typeof id !== 'string') throw new RepoCheckException('provider_error');
    return id;
  }

  static readonly TREE_PAGE = 100;
  static readonly TREE_MAX_PAGES = 10;
  static readonly TREE_FULL_MAX_PAGES = 100;

  /**
   * Fleet S3 §4.1: recursive tree under `path` at `ref`. FleetHttpClient exposes no headers, so paging stops at the first short
   * page; more than TREE_MAX_PAGES full pages is refused (a `.nax/` that large is not a config dir).
   */
  async listTree(access: GitLabAccess, path: string, ref: string): Promise<ForgeTreeEntry[]> {
    const out: ForgeTreeEntry[] = [];
    for (let page = 1; page <= GitLabAccessChecker.TREE_MAX_PAGES; page += 1) {
      // The host is checked again before every page: the answer of the resolver may have changed
      // since the page before, and a page must never leave the process towards a blocked address.
      await this.guard(access.target.apiBase);
      const query = `path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&recursive=true&per_page=${GitLabAccessChecker.TREE_PAGE}&page=${page}`;
      const res = await this.http.request('GET', `${this.projectUrl(access)}/repository/tree?${query}`, { 'private-token': access.token });
      if (res.status === 404) return [];
      if (res.status !== 200 || !Array.isArray(res.body)) this.fail(res.status);
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

  /** Reads the complete recursive tree at a ref, bounded to 100 pages. */
  async getTree(access: GitLabAccess, ref: string): Promise<{ entries: ForgeTreeEntry[]; truncated: boolean }> {
    const entries: ForgeTreeEntry[] = [];
    for (let page = 1; page <= GitLabAccessChecker.TREE_FULL_MAX_PAGES; page += 1) {
      await this.guard(access.target.apiBase);
      const query = `ref=${encodeURIComponent(ref)}&recursive=true&per_page=${GitLabAccessChecker.TREE_PAGE}&page=${page}`;
      const res = await this.http.request('GET', `${this.projectUrl(access)}/repository/tree?${query}`, { 'private-token': access.token });
      if (res.status === 404) throw new RepoCheckException('repo_not_found');
      if (res.status !== 200) this.fail(res.status);
      if (!Array.isArray(res.body)) throw new RepoCheckException('provider_error');
      for (const raw of res.body) {
        const entry = obj(raw);
        if ((entry.type === 'blob' || entry.type === 'tree') && typeof entry.path === 'string' && typeof entry.id === 'string') {
          entries.push({ path: entry.path, type: entry.type, sha: entry.id, size: null });
        }
      }
      if (res.body.length < GitLabAccessChecker.TREE_PAGE) return { entries, truncated: false };
    }
    return { entries, truncated: true };
  }

  /** Reads the first page of merge-request note bodies. */
  async listMergeRequestNotes(access: GitLabAccess, iid: number): Promise<string[]> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/merge_requests/${iid}/notes?per_page=100`, { 'private-token': access.token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    if (!Array.isArray(res.body)) throw new RepoCheckException('provider_error');
    return res.body.map((note: unknown) => obj(note).body).filter((body): body is string => typeof body === 'string');
  }

  /** Reads the authors on a merge-request discussion; null when it no longer exists. */
  async getMergeRequestDiscussion(access: GitLabAccess, iid: number, discussionId: string): Promise<{ authors: string[] } | null> {
    await this.guard(access.target.apiBase);
    const url = `${this.projectUrl(access)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`;
    const res = await this.http.request('GET', url, { 'private-token': access.token });
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res.status);
    const notes = obj(res.body).notes;
    if (!Array.isArray(notes)) throw new RepoCheckException('provider_error');
    const authors = notes.map((note: unknown) => obj(obj(note).author).username).filter((username): username is string => typeof username === 'string');
    return { authors };
  }

  /** Looks up a project or inherited group member by exact, case-insensitive username. */
  async getMemberAccessLevel(access: GitLabAccess, username: string): Promise<number> {
    await this.guard(access.target.apiBase);
    const query = `query=${encodeURIComponent(username)}&per_page=100`;
    const res = await this.http.request('GET', `${this.projectUrl(access)}/members/all?${query}`, { 'private-token': access.token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    if (!Array.isArray(res.body)) throw new RepoCheckException('provider_error');
    const match = res.body.find((member: unknown) => {
      const found = obj(member).username;
      return typeof found === 'string' && found.toLowerCase() === username.toLowerCase();
    });
    return level(match);
  }

  /** Fleet S3 §4.1: one file at a ref (files API, base64). Null when absent. */
  async getFile(access: GitLabAccess, path: string, ref: string): Promise<ForgeFile | null> {
    await this.guard(access.target.apiBase);
    const res = await this.http.request('GET', `${this.projectUrl(access)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`, { 'private-token': access.token });
    if (res.status === 404) return null;
    if (res.status !== 200) this.fail(res.status);
    const b = obj(res.body);
    if (typeof b.blob_id !== 'string' || typeof b.size !== 'number' || b.encoding !== 'base64' || typeof b.content !== 'string') {
      throw new RepoCheckException('provider_error');
    }
    return { sha: b.blob_id, size: b.size, content: Buffer.from(b.content, 'base64') };
  }

  /** The scopes and the expiry of a token. A token the instance does not know is an invalid token. */
  async getTokenSelf(apiBase: string, token: string): Promise<{ scopes: string[]; expiresAt: Date | null }> {
    await this.guard(apiBase);
    const res = await this.http.request('GET', `${trimSlashes(apiBase)}/personal_access_tokens/self`, { 'private-token': token });
    if (res.status === 404) throw new RepoCheckException('gitlab_token_invalid');
    if (res.status !== 200) this.fail(res.status);
    const b = obj(res.body);
    if (!Array.isArray(b.scopes)) throw new RepoCheckException('provider_error');
    const scopes = b.scopes.filter((s): s is string => typeof s === 'string');
    if (b.expires_at === null || b.expires_at === undefined) return { scopes, expiresAt: null };
    if (typeof b.expires_at !== 'string') throw new RepoCheckException('provider_error');
    const expiresAt = new Date(b.expires_at);
    if (Number.isNaN(expiresAt.getTime())) throw new RepoCheckException('provider_error');
    return { scopes, expiresAt };
  }

  /** The account behind a token: a bot account is reported as one. */
  async getCurrentUser(apiBase: string, token: string): Promise<{ id: number; username: string; bot: boolean }> {
    await this.guard(apiBase);
    const res = await this.http.request('GET', `${trimSlashes(apiBase)}/user`, { 'private-token': token });
    if (res.status !== 200) this.fail(res.status);
    const b = obj(res.body);
    if (typeof b.id !== 'number' || typeof b.username !== 'string') throw new RepoCheckException('provider_error');
    return { id: b.id, username: b.username, bot: b.bot === true };
  }

  /**
   * One project of an instance: its numeric id, its canonical path, its default branch and the
   * access level of the token (the higher of the project and the group access).
   */
  async findProject(
    apiBase: string,
    token: string,
    pathOrId: string | number,
  ): Promise<{ id: number; owner: string; name: string; defaultBranch: string; accessLevel: number }> {
    await this.guard(apiBase);
    const path = typeof pathOrId === 'number' ? String(pathOrId) : encodeURIComponent(pathOrId);
    const res = await this.http.request('GET', `${trimSlashes(apiBase)}/projects/${path}`, { 'private-token': token });
    if (res.status === 404) throw new RepoCheckException('repo_not_found');
    if (res.status !== 200) this.fail(res.status);
    const b = obj(res.body);
    const fullPath = b.path_with_namespace;
    if (typeof b.id !== 'number' || typeof fullPath !== 'string' || typeof b.default_branch !== 'string' || !fullPath.includes('/')) {
      throw new RepoCheckException('provider_error');
    }
    const cut = fullPath.lastIndexOf('/');
    const permissions = obj(b.permissions);
    return {
      id: b.id,
      owner: fullPath.slice(0, cut),
      name: fullPath.slice(cut + 1),
      defaultBranch: b.default_branch,
      accessLevel: Math.max(level(permissions.project_access), level(permissions.group_access)),
    };
  }
}

/** The api base without its trailing slashes, so a url is built the same way every time. */
const trimSlashes = (apiBase: string): string => apiBase.replace(/\/+$/, '');
