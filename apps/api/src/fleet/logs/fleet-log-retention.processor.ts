import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ARTIFACT_STORE, ArtifactStore } from '../artifacts/artifact-store';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { ILogRetentionRepository, LOG_RETENTION_REPOSITORY, RetentionCandidate, RetentionCursor } from './domain/log-retention.domain';
import { LOG_STORE, LogStore } from './log-store';

const DAY_MS = 86_400_000;
export const RETENTION_BATCH = 200;

/**
 * Fleet S2a §5 (L4): nightly deletion of the logs, bundles and `log` events of jobs that ended more than
 * FLEET_LOG_RETENTION_DAYS ago. Files first, then rows under the job row lock (D343, D344); attempts newer
 * than the epoch seen at selection are never touched. 04:45 follows enrollment retention (04:30).
 */
@Injectable()
export class FleetLogRetentionProcessor {
  private readonly logger = new Logger(FleetLogRetentionProcessor.name);

  constructor(
    @Inject(LOG_RETENTION_REPOSITORY) private readonly repo: ILogRetentionRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'lockById'>,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(LOG_STORE) private readonly logStore: Pick<LogStore, 'deletePrefix'>,
    @Inject(ARTIFACT_STORE) private readonly artifacts: Pick<ArtifactStore, 'delete'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'logRetentionDays'>,
  ) {}

  @Cron('45 4 * * *')
  async scheduledPurge(): Promise<void> {
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

  /** Every due job, RETENTION_BATCH at a time (D342). One failing job is logged and skipped. */
  async purge(before: Date, now: Date): Promise<{ expired: number; failed: number }> {
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

  /** Spec §5 per job: files of attempts <= E (D343), then rows under the lock (D344). */
  async expireJob(c: RetentionCandidate, now: Date): Promise<void> {
    for (let epoch = 0; epoch <= c.leaseEpoch; epoch += 1) {
      await this.logStore.deletePrefix(`logs/${c.id}/${epoch}/`);
    }
    for (const key of await this.repo.findBundleKeys(c.id, c.leaseEpoch)) {
      await this.artifacts.delete(key);
    }
    await this.txManager.run(async () => {
      if (!(await this.jobs.lockById(c.id))) return;
      await this.repo.expireRows(c.id, c.leaseEpoch, now);
    });
  }
}
