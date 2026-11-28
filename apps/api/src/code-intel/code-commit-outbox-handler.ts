import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { AstIndexService, SourceFile } from './ast-index.service';
import { providerForConnection } from '../vcs/provider-for-connection';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { PrismaCodeIntelRepository } from './prisma-code-intel.repository';
import { batchSourceFiles, isIndexablePath, partitionBySize } from './index-input-limits';

interface CodeCommitPayload {
  repoId: string;
  commitHash: string;
  ref: string;
  changedFiles: string[];
  /** Files the commit deleted. Absent on events recorded before Track 3 Slice 4. */
  removedFiles?: string[];
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

  async process(
    payload: unknown,
    onIndexed?: (result: { symbolsIndexed: number; filesIndexed: number }) => Promise<void>,
  ): Promise<void> {
    const p = payload as CodeCommitPayload;

    if (!p.changedFiles || p.changedFiles.length === 0) {
      this.logger.debug(`code_commit: no changed files, skipping indexing`);
      return;
    }

    this.logger.log(`code_commit: processing ${p.repoId} ${p.commitHash} (${p.changedFiles.length} files)`);

    // VCS LOW: deleted or renamed-away files lose their symbols; they are not fetched.
    const removedFiles = p.removedFiles ?? [];
    if (removedFiles.length > 0) {
      await this.astIndexService.removeFiles(p.projectId, p.repoId, removedFiles);
    }
    const removed = new Set(removedFiles);
    const remaining = p.changedFiles.filter((file) => !removed.has(file));
    if (remaining.length === 0) {
      this.logger.debug(
        `code_commit: all ${removedFiles.length} changed files removed for ${p.repoId} ${p.commitHash}, nothing to index (project ${p.projectId})`,
      );
      return;
    }

    // #534: a push lists every changed path. Only source the extractor understands is fetched; lockfiles, JSON
    // and binaries never reach the compiler.
    const filesToIndex = remaining.filter(isIndexablePath);
    if (filesToIndex.length === 0) {
      this.logger.debug(
        `code_commit: none of ${remaining.length} changed files is indexable for ${p.repoId} ${p.commitHash}, nothing to index (project ${p.projectId})`,
      );
      return;
    }

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

    const provider = providerForConnection(connection, token, this.vcsConfig);

    let sourceFiles: SourceFile[];
    try {
      sourceFiles = await provider.fetchCommitFiles(p.repoId, p.commitHash, filesToIndex);
    } catch (err) {
      this.logger.error(`code_commit: failed to fetch commit files: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    this.logger.log(`code_commit: fetched ${sourceFiles.length} files for ${p.commitHash}`);

    // #534: an oversized file is not parsed. Like a file that fails to parse, it loses the symbols an earlier,
    // smaller version left behind.
    const { accepted, oversized } = partitionBySize(sourceFiles);
    if (oversized.length > 0) {
      this.logger.warn(`code_commit: ${oversized.length} files over the index size cap skipped for ${p.repoId} ${p.commitHash}`);
      await this.astIndexService.removeFiles(p.projectId, p.repoId, oversized);
    }

    // #534: one extraction holds a bounded number of files and bytes. Relationships are resolved inside a batch,
    // so a call between two files of a commit larger than one batch is recorded only when both share a batch.
    for (const batch of batchSourceFiles(accepted)) {
      await this.astIndexService.indexCommit(p.repoId, p.commitHash, batch, p.projectId, onIndexed);
    }
  }
}
