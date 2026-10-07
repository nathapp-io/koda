import { Injectable } from '@nestjs/common';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, fileNotFound, forgeCall, FleetRepoFilesReader, NaxFileContent, NaxFileList, toNaxEntries } from './fleet-repo-files.reader';

/** GitLab: the project's VcsConnection token, as the git broker uses it (D468). */
@Injectable()
export class GitlabFleetRepoFilesReader implements FleetRepoFilesReader {
  constructor(
    private readonly gitlab: GitLabAccessChecker,
    private readonly tokens: GitLabTokenSource,
  ) {}

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    return forgeCall(async () => {
      const token = await this.tokens.resolve(repo.projectId, repo.owner, repo.name);
      const baseSha = await this.gitlab.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
      const entries = await this.gitlab.listTree(token, repo.owner, repo.name, '.nax', baseSha);
      return { baseSha, defaultBranch: repo.defaultBranch, files: toNaxEntries(entries) };
    });
  }

  async read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    const file = await forgeCall(async () => this.gitlab.getFile(await this.tokens.resolve(repo.projectId, repo.owner, repo.name), repo.owner, repo.name, path, ref));
    if (!file) throw fileNotFound();
    return decodeNaxFile(path, file);
  }
}
