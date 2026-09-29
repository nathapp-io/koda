import { Inject, Injectable } from '@nestjs/common';
import { decryptToken } from '../../common/utils/encryption.util';
import { IVcsConfig, VCS_CFG } from '../../config/vcs.config';
import { VCS_REPOSITORY } from '../../vcs/domain/vcs.repository';
import type { IVcsRepository } from '../../vcs/domain/vcs.repository';
import { RepoCheckException } from './repo-check.exception';

/** The project's stored GitLab token, only for its connected repo (spec §7.1: one GitLab fleet repo per project). */
@Injectable()
export class GitLabTokenSource {
  constructor(
    @Inject(VCS_REPOSITORY) private readonly vcsRepo: Pick<IVcsRepository, 'findVcsConnectionByProjectId'>,
    @Inject(VCS_CFG) private readonly vcsConfig: Pick<IVcsConfig, 'encryptionKey'>,
  ) {}

  async resolve(projectId: string, owner: string, name: string): Promise<string> {
    const connection = await this.vcsRepo.findVcsConnectionByProjectId(projectId);
    if (!connection) throw new RepoCheckException('vcs_connection_missing');
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (connection.provider !== 'gitlab' || !same(connection.repoOwner, owner) || !same(connection.repoName, name)) {
      throw new RepoCheckException('vcs_connection_mismatch');
    }
    if (!this.vcsConfig.encryptionKey) throw new RepoCheckException('vcs_encryption_key_missing');
    try {
      return decryptToken(connection.encryptedToken, this.vcsConfig.encryptionKey);
    } catch {
      throw new RepoCheckException('gitlab_token_invalid');
    }
  }
}
