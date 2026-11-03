import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { PROJECT_SOFT_DELETED, type ProjectSoftDeletedEvent } from '../../projects/project-events';
import { FleetJobsService } from './fleet-jobs.service';
import { FleetJobLivePublisher } from './fleet-job-live.publisher';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Review P2 remainder (US-001): a soft-deleted project stops spending fleet budget.
 *
 * `ProjectsService` emits `PROJECT_SOFT_DELETED` after the delete committed, so this handler's transaction
 * is a new one and cannot join — or roll back — that delete. It ends the project's unstarted jobs
 * (`FleetJobsService.cancelForProjectDelete`: QUEUED, and ASSIGNED whose ASSIGN the runner never acked)
 * and records one `system.project.quiesce` audit entry in the same transaction, then publishes the live
 * events the transitions returned, after the commit. RUNNING, UPLOADING and acked ASSIGNED jobs finish and
 * report as usual (spec ruling 15).
 *
 * It never rejects: the delete has already committed, so a failure here must not reach the delete's caller.
 * A failed quiesce is logged and recovered by nothing else — the next dispatch to the project 404s, and the
 * jobs it could not end stay visible as the project's own until someone removes them by hand.
 */
@Injectable()
@SystemWriter('system.project.quiesce')
export class ProjectDeletionJobsListener {
  private readonly logger = new Logger(ProjectDeletionJobsListener.name);

  constructor(
    private readonly jobs: FleetJobsService,
    private readonly audit: AuditRecorder,
    private readonly live: FleetJobLivePublisher,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  @OnEvent(PROJECT_SOFT_DELETED)
  async onProjectSoftDeleted(event: ProjectSoftDeletedEvent): Promise<void> {
    try {
      const result = await runAsSystemWriter(this, () => this.txManager.run(async () => {
        const r = await this.jobs.cancelForProjectDelete(event.projectId);
        await this.audit.record({
          key: 'system.project.quiesce',
          resourceType: 'project',
          resourceId: event.projectId,
          projectId: event.projectId,
          summary: `project deleted: ${r.cancelled.length} unstarted jobs cancelled`,
        });
        return r;
      }));
      this.live.publish(result.live);
    } catch (error) {
      this.logger.error(`project ${event.projectId} quiesce failed: ${messageOf(error)}`);
    }
  }
}
