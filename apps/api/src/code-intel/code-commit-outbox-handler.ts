import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { AstIndexService, SourceFile } from './ast-index.service';
import { createVcsProvider } from '../vcs/factory';
import type { VcsProviderConfig } from '../vcs/factory';

interface CodeCommitPayload {
  repoId: string;
  commitHash: string;
  ref: string;
  changedFiles: string[];
  projectId: string;
  webhookOnly?: boolean;
}

interface VcsConnectionDelegate {
  findUnique(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
}

interface ExtendedPrismaClient {
  vcsConnection: VcsConnectionDelegate
  [key: string]: unknown
}

@Injectable()
export class CodeCommitOutboxHandler {
  private readonly logger = new Logger(CodeCommitOutboxHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly astIndexService: AstIndexService,
    @Optional() @Inject(ConfigService) private readonly configService?: ConfigService,
  ) {}

  private get db() {
    return this.prisma.client as unknown as ExtendedPrismaClient;
  }

  async process(payload: unknown): Promise<void> {
    const p = payload as CodeCommitPayload;

    if (p.webhookOnly || !p.changedFiles || p.changedFiles.length === 0) {
      this.logger.debug(`code_commit: webhook-only or no changed files, skipping indexing`);
      return;
    }

    this.logger.log(`code_commit: processing ${p.repoId} ${p.commitHash} (${p.changedFiles.length} files)`);

    const connection = await this.getVcsConnection(p.projectId);
    if (!connection) {
      this.logger.warn(`code_commit: no VCS connection found for project ${p.projectId}`);
      return;
    }

    const encryptionKey = this.configService?.get<string>('vcs.encryptionKey');
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

  private async getVcsConnection(projectId: string): Promise<{
    provider: string;
    repoOwner: string;
    repoName: string;
    encryptedToken: string;
  } | null> {
    const connection = (await this.db.vcsConnection.findUnique({
      where: { projectId },
    })) as { provider: string; repoOwner: string; repoName: string; encryptedToken: string } | null;

    return connection;
  }
}