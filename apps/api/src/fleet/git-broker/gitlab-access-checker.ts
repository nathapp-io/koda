import { Inject, Injectable } from '@nestjs/common';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { FleetHttpClient } from './fleet-http-client';
import type { CanonicalRepo } from './github-app-client';
import { RepoCheckException } from './repo-check.exception';

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
