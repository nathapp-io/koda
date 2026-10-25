import { SystemWriter } from '../../permissions/system-writer.decorator';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { runAsSystemWriter } from '../../action-context/action-context';
import { AuditRecorder } from '../../audit/audit-recorder.service';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IRunnerRepository, RUNNER_REPOSITORY } from './domain/runner.domain';

/**
 * #162: nightly purge of spent runner enrollment rows, the fleet analogue of the
 * outbox retention purge (#135). A used or expired token is inert; the trail lives
 * in FleetActivity (`enrollment.created`, `runner.enrolled`). 04:30 avoids memory
 * governance (03:00) and outbox retention (04:00). Errors are logged and swallowed.
 */
@Injectable()
@SystemWriter('system.enrollment.retention')
export class EnrollmentRetentionProcessor {
  private readonly logger = new Logger(EnrollmentRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: Pick<IRunnerRepository, 'deleteSpentEnrollmentsBefore'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'enrollmentRetentionDays'>,
    private readonly audit: AuditRecorder,
  ) {}

  /** Permissions P2 US-004: the cron method is the background entry; the purge runs as `enrollment`. */
  @Cron('30 4 * * *')
  scheduledPurge(): Promise<void> {
    return runAsSystemWriter(this, () => this.purgeSpentEnrollments());
  }

  private async purgeSpentEnrollments(): Promise<void> {
    const days = this.config.enrollmentRetentionDays;
    if (days === null || days <= 0) return;
    const before = new Date(Date.now() - days * EnrollmentRetentionProcessor.DAY_MS);
    try {
      const deleted = await this.audit.audited(
        () => this.repo.deleteSpentEnrollmentsBefore(before),
        (count) => count === 0 ? [] : [{
          key: 'system.enrollment.retention',
          resourceType: 'fleet-enrollment',
          resourceId: 'all',
          projectId: null,
          summary: `purged ${count} spent enrollments`,
        }],
      );
      this.logger.log(`Purged ${deleted} spent runner enrollment(s) older than ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Enrollment retention purge failed, will retry next run: ${message}`);
    }
  }
}
