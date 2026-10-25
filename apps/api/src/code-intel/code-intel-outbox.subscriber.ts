import { SystemWriter } from '../permissions/system-writer.decorator';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AstIndexService, SourceFile } from './ast-index.service';
import { CodeCommitOutboxHandler } from './code-commit-outbox-handler';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { runAsSystemWriter } from '../action-context/action-context';

@Injectable()
@SystemWriter('system.codeintel.index-commit')
export class CodeIntelOutboxSubscriber implements OnModuleInit {
  private readonly logger = new Logger(CodeIntelOutboxSubscriber.name);

  constructor(
    private readonly registry: FanOutPublisher,
    private readonly audit: AuditRecorder,
    @Optional() private readonly codeCommitHandler?: CodeCommitOutboxHandler,
    @Optional() private readonly astIndexService?: AstIndexService,
  ) {}

  onModuleInit(): void {
    if (this.codeCommitHandler || this.astIndexService) {
      this.registry.register('code_commit', this.handleCodeCommit.bind(this));
      this.logger.debug('CodeIntel outbox handler registered');
    }
  }

  private async handleCodeCommit(payload: unknown): Promise<void> {
    await runAsSystemWriter(this, () => this.indexCodeCommit(payload));
  }

  private async indexCodeCommit(payload: unknown): Promise<void> {
    const p = payload as Record<string, unknown>;
    const repoId = p.repoId as string | undefined;
    const commitHash = p.commitHash as string | undefined;
    const projectId = p.projectId as string | undefined;
    const webhookOnly = p.webhookOnly as boolean | undefined;
    const changedFiles = (p.changedFiles as SourceFile[] | undefined)
      ?? (p.files as SourceFile[] | undefined);

    const onIndexed = async (indexed: { symbolsIndexed: number; filesIndexed: number }): Promise<void> => {
      if (!repoId || !projectId) {
        throw new Error('code_commit: missing repoId or projectId for index audit');
      }
      await this.audit.record({
        key: 'system.codeintel.index-commit',
        resourceType: 'code-repo',
        resourceId: repoId,
        projectId,
        summary: `indexed ${indexed.symbolsIndexed} symbols in ${indexed.filesIndexed} files`,
      });
    };

    if (this.codeCommitHandler) {
      this.logger.debug('code_commit: delegating to CodeCommitOutboxHandler');
      await this.codeCommitHandler.process(p, onIndexed);
      return;
    }

    if (webhookOnly) {
      this.logger.warn('code_commit: webhook payload requires CodeCommitOutboxHandler, but it is not registered');
      return;
    }

    if (!changedFiles || !Array.isArray(changedFiles) || changedFiles.length === 0) {
      this.logger.debug('code_commit: no changed files provided');
      return;
    }

    if (!repoId || !commitHash || !projectId) {
      this.logger.debug('code_commit: missing required fields (repoId, commitHash, projectId)');
      return;
    }

    if (!this.astIndexService) return;

    this.logger.log(`code_commit: indexing ${repoId} ${commitHash} (${changedFiles.length} files)`);
    await this.astIndexService.indexCommit(repoId, commitHash, changedFiles, projectId, onIndexed);
  }
}
