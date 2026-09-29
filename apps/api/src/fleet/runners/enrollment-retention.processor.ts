import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { IRunnerRepository, RUNNER_REPOSITORY } from './domain/runner.domain';

/**
 * #162: nightly purge of spent runner enrollment rows, the fleet analogue of the
 * outbox retention purge (#135). A used or expired token is inert; the trail lives
 * in FleetActivity (`enrollment.created`, `runner.enrolled`). 04:30 avoids memory
 * governance (03:00) and outbox retention (04:00). Errors are logged and swallowed.
 */
@Injectable()
export class EnrollmentRetentionProcessor {
  private readonly logger = new Logger(EnrollmentRetentionProcessor.name);
  private static readonly DAY_MS = 86_400_000;

  constructor(
    @Inject(RUNNER_REPOSITORY) private readonly repo: Pick<IRunnerRepository, 'deleteSpentEnrollmentsBefore'>,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'enrollmentRetentionDays'>,
  ) {}

  @Cron('30 4 * * *')
  async scheduledPurge(): Promise<void> {
    const days = this.config.enrollmentRetentionDays;
    if (days === null || days <= 0) return;
    const before = new Date(Date.now() - days * EnrollmentRetentionProcessor.DAY_MS);
    try {
      const deleted = await this.repo.deleteSpentEnrollmentsBefore(before);
      this.logger.log(`Purged ${deleted} spent runner enrollment(s) older than ${before.toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Enrollment retention purge failed, will retry next run: ${message}`);
    }
  }
}
