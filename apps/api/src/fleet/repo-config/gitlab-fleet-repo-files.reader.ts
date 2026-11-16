import { Injectable } from '@nestjs/common';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, fileNotFound, forgeCall, FleetRepoFilesReader, NaxFileContent, NaxFileList, toNaxEntries } from './fleet-repo-files.reader';

/** GitLab: the repo's own read credential, as the git broker uses it (US-002). */
@Injectable()
export class GitlabFleetRepoFilesReader implements FleetRepoFilesReader {
  constructor(
    private readonly gitlab: GitLabAccessChecker,
    private readonly credentials: GitLabRepoCredentials,
  ) {}

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    return forgeCall(async () => this.credentials.call(repo, 'read', async (access) => {
      const baseSha = await this.gitlab.getBranchHead(access, repo.defaultBranch);
      const entries = await this.gitlab.listTree(access, '.nax', baseSha);
      return { baseSha, defaultBranch: repo.defaultBranch, files: toNaxEntries(entries) };
    }));
  }

  async read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    const file = await forgeCall(async () => this.credentials.call(repo, 'read', (access) => this.gitlab.getFile(access, path, ref)));
    if (!file) throw fileNotFound();
    return decodeNaxFile(path, file);
  }
}
