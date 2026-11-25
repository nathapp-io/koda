import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ILogRetentionRepository, LOG_RETENTION_REPOSITORY, RetiredCleanupCursor, RetiredCleanupRecord, RetentionCandidate, RetentionCursor } from './domain/log-retention.domain';
import { LOG_STORE, LogStore } from './log-store';

const DAY_MS = 86_400_000;
export const RETENTION_BATCH = 200;

/**
 * Fleet S2a §5 (L4): nightly deletion of the logs, bundles and `log` events of jobs that ended more than
 * FLEET_LOG_RETENTION_DAYS ago. Files first, then rows under the job row lock (D343, D344); attempts newer
 * than the epoch seen at selection are never touched. 04:45 follows enrollment retention (04:30).
 *
 * US-009 (finding 5): the same pass finishes the work a fleet repository delete captured in
 * `FleetRetiredJobCleanup`, because that delete cascaded away the rows that named the files.
 */
@Injectable()
@SystemWriter('system.log.retention')
export class FleetLogRetentionProcessor {
  private readonly logger = new Logger(FleetLogRetentionProcessor.name);

  constructor(
    @Inject(LOG_RETENTION_REPOSITORY) private readonly repo: ILogRetentionRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById'>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(LOG_STORE) private readonly logStore: Pick<LogStore, 'deletePrefix'>,
    @Inject(ARTIFACT_STORE) private readonly artifacts: Pick<ArtifactStore, 'delete'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'logRetentionDays'>,
    private readonly audit: AuditRecorder,
  ) {}

  /** Permissions P2 US-004: the cron method is the background entry; the purge runs as `log`. */
  @Cron('45 4 * * *')
  scheduledPurge(): Promise<void> {
    return runAsSystemWriter(this, () => this.purgeExpiredLogs());
  }

  private async purgeExpiredLogs(): Promise<void> {
    const days = this.config.logRetentionDays;
    if (days === null || days <= 0) return;
    const now = new Date();
    try {
      const { expired, failed } = await this.purge(new Date(now.getTime() - days * DAY_MS), now);
      this.logger.log(`Expired the logs of ${expired} job(s) that ended more than ${days} day(s) ago; ${failed} failed`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Log retention failed, will retry next run: ${message}`);
    }
  }

  /** Every due job, then every due retired job, RETENTION_BATCH at a time (D342). One failing target is logged and skipped. */
  async purge(before: Date, now: Date): Promise<{ expired: number; failed: number }> {
    const live = await this.purgeJobs(before, now);
    // US-009 (finding 5): the work a repository delete handed over, with the same cutoff and the same bound.
    const retired = await this.purgeRetiredJobs(before);
    return { expired: live.expired + retired.expired, failed: live.failed + retired.failed };
  }

  private async purgeJobs(before: Date, now: Date): Promise<{ expired: number; failed: number }> {
    let after: RetentionCursor | null = null;
    let expired = 0;
    let failed = 0;
    for (;;) {
      const batch = await this.repo.findCandidates(before, after, RETENTION_BATCH);
      for (const candidate of batch) {
        try {
          await this.expireJob(candidate, now);
          expired += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Log retention skipped job ${candidate.id}: ${message}`);
        }
      }
      if (batch.length < RETENTION_BATCH) return { expired, failed };
      const last = batch[batch.length - 1];
      after = { finishedAt: last.finishedAt, id: last.id };
    }
  }

  /**
   * US-009: the files of the jobs whose repository was deleted. The rows that named them are gone, so the
   * captured record is both the work list and the acknowledgement: it is removed only once every one of its
   * targets is deleted, and a record whose deletion failed stays for the next run. The cursor is the page's
   * last record, never the last one that succeeded, so a record that keeps failing cannot pin the pass on the
   * same page and hide the eligible work after it.
   */
  private async purgeRetiredJobs(before: Date): Promise<{ expired: number; failed: number }> {
    let after: RetiredCleanupCursor | null = null;
    let expired = 0;
    let failed = 0;
    for (;;) {
      const batch = await this.repo.findRetiredCleanups(before, after, RETENTION_BATCH);
      for (const record of batch) {
        try {
          await this.completeRetiredJob(record);
          expired += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Log retention left the cleanup of retired job ${record.jobId} pending: ${message}`);
        }
      }
      if (batch.length < RETENTION_BATCH) return { expired, failed };
      const last = batch[batch.length - 1];
      after = { finishedAt: last.finishedAt, id: last.id };
    }
  }

  /**
   * US-009: one retired job. The targets are the same ones the live pass deletes — every log prefix up to the
   * captured epoch, then the exact bundle keys — and both stores tolerate a target that is already gone, so a
   * retry after a partial deletion finishes the rest. Only after all of them are deleted is the record
   * acknowledged, with its audit entry, in one transaction.
   */
  async completeRetiredJob(record: RetiredCleanupRecord): Promise<void> {
    for (let epoch = 0; epoch <= record.leaseEpoch; epoch += 1) {
      await this.logStore.deletePrefix(`logs/${record.jobId}/${epoch}/`);
    }
    for (const key of record.bundleKeys) {
      await this.artifacts.delete(key);
    }
    await this.txManager.run(async () => {
      await this.repo.deleteRetiredCleanup(record.id);
      await this.audit.record({
        key: 'system.log.retention',
        resourceType: 'fleet-job',
        resourceId: record.jobId,
        // The job and its repository are gone: the audit entry has no project to hang from any more.
        projectId: null,
        summary: `retired job's logs and bundles deleted through epoch ${record.leaseEpoch}`,
      });
    });
  }

  /** Spec §5 per job: files of attempts <= E (D343), then rows under the lock (D344). */
  async expireJob(c: RetentionCandidate, now: Date): Promise<void> {
    for (let epoch = 0; epoch <= c.leaseEpoch; epoch += 1) {
      await this.logStore.deletePrefix(`logs/${c.id}/${epoch}/`);
    }
    for (const key of await this.repo.findBundleKeys(c.id, c.leaseEpoch)) {
      await this.artifacts.delete(key);
    }
    await this.txManager.run(async () => {
      const job = await this.jobs.lockById(c.id);
      if (!job) return;
      await this.repo.expireRows(c.id, c.leaseEpoch, now);
      await this.audit.record({
        key: 'system.log.retention',
        resourceType: 'fleet-job',
        resourceId: c.id,
        projectId: job.projectId,
        summary: `logs expired through epoch ${c.leaseEpoch}`,
      });
    });
  }
}
