import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { AstIndexService, SourceFile } from './ast-index.service';
import { createVcsProvider } from '../vcs/factory';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import type { VcsProviderConfig } from '../vcs/factory';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';

interface CodeCommitPayload {
  repoId: string;
  commitHash: string;
  ref: string;
  changedFiles: string[];
  projectId: string;
  webhookOnly?: boolean;
}

@Injectable()
export class CodeCommitOutboxHandler {
  private readonly logger = new Logger(CodeCommitOutboxHandler.name);

  constructor(
    private readonly codeIntelRepository: PrismaCodeIntelRepository,
    private readonly astIndexService: AstIndexService,
    @Optional() @Inject(VCS_CFG) private readonly vcsConfig?: IVcsConfig,
  ) {}

  async process(payload: unknown): Promise<void> {
    const p = payload as CodeCommitPayload;

    if (!p.changedFiles || p.changedFiles.length === 0) {
      this.logger.debug(`code_commit: no changed files, skipping indexing`);
      return;
    }

    this.logger.log(`code_commit: processing ${p.repoId} ${p.commitHash} (${p.changedFiles.length} files)`);

    const connection = await this.codeIntelRepository.findVcsConnectionByProjectId(p.projectId);
    if (!connection) {
      this.logger.warn(`code_commit: no VCS connection found for project ${p.projectId}`);
      return;
    }

    const encryptionKey = this.vcsConfig?.encryptionKey;
    if (!encryptionKey) {
      this.logger.error(`code_commit: VCS encryption key not configured`);
      return;
    }

    const { decryptToken } = await import('../common/utils/encryption.util');
    let token: string;
    try {
      token = decryptToken(connection.encryptedToken, encryptionKey);
    } catch (err) {
      this.logger.error(`code_commit: failed to decrypt VCS token: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const providerConfig: VcsProviderConfig = {
      provider: connection.provider,
      token,
      repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
    };
    const provider = createVcsProvider(connection.provider, providerConfig);

    let sourceFiles: SourceFile[];
    try {
      sourceFiles = await provider.fetchCommitFiles(p.repoId, p.commitHash, p.changedFiles);
    } catch (err) {
      this.logger.error(`code_commit: failed to fetch commit files: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    this.logger.log(`code_commit: fetched ${sourceFiles.length} files for ${p.commitHash}`);
    await this.astIndexService.indexCommit(p.repoId, p.commitHash, sourceFiles, p.projectId);
  }
}
