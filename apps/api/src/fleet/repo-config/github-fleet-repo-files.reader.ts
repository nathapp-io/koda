import { Injectable } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { decodeNaxFile, fileNotFound, forgeCall, FleetRepoFilesReader, NaxFileContent, NaxFileList, toNaxEntries } from './fleet-repo-files.reader';
import { ForgeErrorException, RepoUnreachableException } from './repo-config.exceptions';

/** GitHub: a fresh installation token per request (D468; the broker's cache is keyed by job and epoch). */
@Injectable()
export class GithubFleetRepoFilesReader implements FleetRepoFilesReader {
  constructor(private readonly github: GitHubAppClient) {}

  private async token(repo: FleetRepoRef): Promise<string> {
    if (repo.githubInstallationId === null) throw new RepoUnreachableException('no_installation');
    return (await this.github.mintInstallationToken(repo.githubInstallationId, repo.name)).token;
  }

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    return forgeCall(async () => {
      const token = await this.token(repo);
      const baseSha = await this.github.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch);
      const sub = await this.github.getSubtree(token, repo.owner, repo.name, baseSha, '.nax', true);
      if (!sub) return { baseSha, defaultBranch: repo.defaultBranch, files: [] };
      if (sub.truncated) throw new ForgeErrorException();
      return { baseSha, defaultBranch: repo.defaultBranch, files: toNaxEntries(sub.entries.map((e) => ({ ...e, path: `.nax/${e.path}` }))) };
    });
  }

  async read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    const file = await forgeCall(async () => this.github.getFile(await this.token(repo), repo.owner, repo.name, path, ref));
    if (!file) throw fileNotFound();
    return decodeNaxFile(path, file);
  }
}
