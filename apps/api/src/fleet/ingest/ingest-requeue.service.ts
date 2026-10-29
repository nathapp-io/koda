import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { committedEffect } from '../../common/committed-effects';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { bookkeeping } from '../../action-context/audit-coverage';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { BundleIngestService } from './bundle-ingest.service';
import { BUNDLE_INGEST_REPOSITORY, IBundleIngestRepository, INGEST_PARSER_VERSION } from './domain/bundle-ingest.domain';

/** Shared orchestration for immediate and approved global ingest writes. */
@Injectable()
export class IngestRequeueService {
  constructor(
    @Inject(BUNDLE_INGEST_REPOSITORY) private readonly repo: IBundleIngestRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findById'>,
    private readonly ingest: BundleIngestService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
  ) {}

  async backfill(actorId: string) {
    return this.queue(
      actorId, 'ingest.backfill', 'ingest', 'all', null, 'fleet.ingest.backfill', 'fleet-ingest', 'all',
      (n) => `backfill queued ${n}`, () => this.repo.backfill(INGEST_PARSER_VERSION),
    );
  }

  async rerunJob(actorId: string, jobId: string) {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new NotFoundAppException({}, 'fleet.jobs');
    return this.queue(
      actorId, 'ingest.rerun', 'job', job.id, job.projectId, 'fleet.ingest.rerun', 'fleet-job', job.id,
      (n) => `rerun queued ${n}`, () => this.repo.rerunJob(job.id),
    );
  }

  async rerunOutdated(actorId: string) {
    return this.queue(
      actorId, 'ingest.rerun_outdated', 'ingest', 'all', null, 'fleet.ingest.rerun', 'fleet-ingest', 'all',
      (n) => `rerun outdated queued ${n}`, () => this.repo.rerunOutdated(INGEST_PARSER_VERSION),
    );
  }

  private async queue(
    actorId: string, action: string, entityType: 'ingest' | 'job', entityId: string, projectId: string | null,
    auditKey: string, resourceType: string, resourceId: string, auditSummary: (count: number) => string, run: () => Promise<number>,
  ): Promise<{ queued: number }> {
    const queued = await this.txManager.run(async () => {
      const n = await run();
      await bookkeeping('fleet.ingest-progress', () => this.activity.record({
        actorType: 'USER', actorId, action, entityType, entityId, jobId: entityType === 'job' ? entityId : null, projectId,
        responsibleUserId: actorId, payload: { queued: n, parserVersion: INGEST_PARSER_VERSION },
      }));
      if (n > 0) {
        await this.audit.record({ key: auditKey, resourceType, resourceId, projectId, summary: auditSummary(n) });
      }
      return n;
    });
    committedEffect(() => this.ingest.kick());
    return { queued };
  }
}
