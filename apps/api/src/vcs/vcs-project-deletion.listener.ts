import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../action-context/action-context';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { SystemWriter } from '../permissions/system-writer.decorator';
import { PROJECT_SOFT_DELETED, type ProjectSoftDeletedEvent } from '../projects/project-events';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import { VcsPollingService } from './vcs-polling.service';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Review P2 remainder (US-002): a soft-deleted project stops polling its VCS repository.
 *
 * `ProjectsService` emits `PROJECT_SOFT_DELETED` after the delete committed, so this handler's
 * transaction is a new one and cannot join — or roll back — that delete. It deactivates the project's
 * active connections and records one `system.project.quiesce` entry per connection in that transaction,
 * then removes each polling schedule after the commit: a schedule removed from inside a transaction that
 * then rolled back would stop polling a connection still marked active, while the connection's own
 * `isActive` flag is what the next boot reads.
 *
 * It never rejects: the delete has already committed, so a failure here must not reach the delete's
 * caller. Node keeps the in-memory interval going until the process ends, but recovery does not depend on
 * this listener: `findVcsConnectionById` no longer answers a deleted project's connection, so the very
 * next polling tick unschedules it (spec `Failure Handling`).
 */
@Injectable()
@SystemWriter('system.project.quiesce')
export class VcsProjectDeletionListener {
  private readonly logger = new Logger(VcsProjectDeletionListener.name);

  constructor(
    @Inject(VCS_REPOSITORY) private readonly repo: IVcsRepository,
    private readonly polling: VcsPollingService,
    private readonly audit: AuditRecorder,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  @OnEvent(PROJECT_SOFT_DELETED)
  async onProjectSoftDeleted(event: ProjectSoftDeletedEvent): Promise<void> {
    try {
      const connectionIds = await runAsSystemWriter(this, () => this.txManager.run(async () => {
        const deactivated = await this.repo.deactivateConnectionsForProject(event.projectId);
        for (const connectionId of deactivated) {
          await this.audit.record({
            key: 'system.project.quiesce',
            resourceType: 'vcs-connection',
            resourceId: connectionId,
            projectId: event.projectId,
            summary: 'deactivated: project deleted',
          });
        }
        return deactivated;
      }));
      for (const connectionId of connectionIds) this.polling.unschedulePolling(connectionId);
    } catch (error) {
      this.logger.error(`project ${event.projectId} vcs quiesce failed: ${messageOf(error)}`);
    }
  }
}
