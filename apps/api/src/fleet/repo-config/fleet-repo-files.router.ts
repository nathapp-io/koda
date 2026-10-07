import { Injectable } from '@nestjs/common';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import type { FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';
import { GithubFleetRepoFilesReader } from './github-fleet-repo-files.reader';
import { GitlabFleetRepoFilesReader } from './gitlab-fleet-repo-files.reader';

@Injectable()
export class FleetRepoFilesRouter implements FleetRepoFilesReader {
  constructor(
    private readonly github: GithubFleetRepoFilesReader,
    private readonly gitlab: GitlabFleetRepoFilesReader,
  ) {}

  private pick(repo: FleetRepoRef): FleetRepoFilesReader {
    return repo.provider === 'github' ? this.github : this.gitlab;
  }

  list(repo: FleetRepoRef): Promise<NaxFileList> {
    return this.pick(repo).list(repo);
  }

  read(repo: FleetRepoRef, path: string, ref: string): Promise<NaxFileContent> {
    return this.pick(repo).read(repo, path, ref);
  }
}
