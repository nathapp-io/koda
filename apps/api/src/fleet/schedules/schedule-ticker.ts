import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { BudgetPausedException } from '../budgets/budget.exceptions';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { FleetJobsService } from '../jobs/fleet-jobs.service';
import { nextFireAfter } from './cron-schedule';
import { AutoDisableReason, IScheduleRepository, SCHEDULE_REPOSITORY, ScheduleRecord } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';
import { SYSTEM_ACTOR_ID, schedulePayload } from './schedule-payloads';
import { ScheduleProgressService } from './schedule-progress.service';
import { toDispatchDto } from './schedule-template';

const TICK_INTERVAL_MS = 60_000;
/** Plan D207: a tick handles at most this many due schedules; the rest wait one more minute. */
const MAX_DUE_PER_TICK = 100;
/** Plan D200: rounds of "read the active job, try to coalesce" before giving up. */
const MAX_COALESCE_ROUNDS = 3;

export interface TickResult {
  /** Schedules this tick claimed and acted on: dispatched + coalesced + skipped + disabled. */
  claimed: number;
  dispatched: number;
  coalesced: number;
  skipped: number;
  disabled: number;
  failed: number;
}

type Outcome = 'lost' | 'dispatched' | 'coalesced' | 'skipped' | 'disabled' | 'failed';

const tally = (outcomes: readonly Outcome[]): TickResult => {
  const n = (o: Outcome): number => outcomes.filter((x) => x === o).length;
  const [dispatched, coalesced, skipped, disabled] = [n('dispatched'), n('coalesced'), n('skipped'), n('disabled')];
  return { claimed: dispatched + coalesced + skipped + disabled, dispatched, coalesced, skipped, disabled, failed: n('failed') };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * S1b §3.2. Every 60 s: load the due schedules, claim each by compare-and-set on `nextFireAt`, then coalesce into
 * its QUEUED job, skip while it runs, or dispatch RUN as the owner. In process: the API is single-instance and
 * there is no distributed lock; the claim is what keeps two overlapping ticks from firing twice (plan D198).
 */
@Injectable()
export class ScheduleTicker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleTicker.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    private readonly jobs: FleetJobsService,
    private readonly progress: ScheduleProgressService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'sweepEnabled'>,
  ) {}

  onModuleInit(): void {
    if (!this.fleetConfig.sweepEnabled) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => this.logger.error(`Schedule tick failed: ${messageOf(error)}`));
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One timer round; null when the previous round is still running (plan D198). */
  async runOnce(now = new Date()): Promise<TickResult | null> {
    if (this.ticking) return null;
    this.ticking = true;
    try {
      return await this.tick(now);
    } finally {
      this.ticking = false;
    }
  }

  async tick(now = new Date()): Promise<TickResult> {
    const outcomes: Outcome[] = [];
    for (const due of await this.repo.findDue(now, MAX_DUE_PER_TICK)) outcomes.push(await this.fireDue(due, now));
    return tally(outcomes);
  }

  /** One failing schedule is logged and skipped; the rest still run. */
  private async fireDue(due: ScheduleRecord, now: Date): Promise<Outcome> {
    try {
      let next: Date;
      try {
        next = nextFireAfter(due.cron, due.timezone, now);
      } catch (error) {
        await this.disable(due, 'template_invalid', `cron does not parse: ${messageOf(error)}`);
        return 'disabled';
      }
      if (!(await this.repo.claimFire(due.id, due.nextFireAt, next, now))) return 'lost';
      return await this.fire(due);
    } catch (error) {
      this.logger.error(`Schedule ${due.id} failed: ${messageOf(error)}`);
      return 'failed';
    }
  }

  private async fire(s: ScheduleRecord): Promise<Outcome> {
    for (let round = 0; round < MAX_COALESCE_ROUNDS; round += 1) {
      const active = await this.repo.findActiveJob(s.id);
      if (!active) return this.dispatchFresh(s);
      if (active.state !== 'QUEUED') {
        await this.record(s, 'schedule.tick_skipped', { reason: 'job_active', jobId: active.id, state: active.state });
        return 'skipped';
      }
      const absorbed = await this.repo.coalesceIntoQueued(s.id);
      if (absorbed) {
        await this.record(s, 'schedule.tick_coalesced', { jobId: absorbed });
        return 'coalesced';
      }
    }
    await this.record(s, 'schedule.tick_skipped', { reason: 'busy' });
    return 'skipped';
  }

  private async dispatchFresh(s: ScheduleRecord): Promise<Outcome> {
    if (!mayDispatch(await this.repo.findOwnerAccess(s.projectId, s.createdById))) {
      await this.disable(s, 'owner_lost_access');
      return 'disabled';
    }
    let jobId: string;
    try {
      // No transaction is open here (plan D198): a 409 from the (repoId, feature) index must not poison one.
      jobId = (await this.jobs.dispatch(s.createdById, s.projectId, toDispatchDto(s), { scheduleId: s.id })).job.id;
    } catch (error) {
      return this.onDispatchError(s, error);
    }
    await this.linkDispatched(s, jobId, {});
    return 'dispatched';
  }

  /** Sets lastJobId and records the dispatch in one transaction. */
  private linkDispatched(s: ScheduleRecord, jobId: string, extra: Record<string, unknown>): Promise<void> {
    return this.txManager.run(async () => {
      await this.repo.update(s.id, { lastJobId: jobId });
      await this.record(s, 'schedule.tick_dispatched', { jobId, ...extra });
    });
  }

  /** Plan D199: most specific first; BudgetPausedException is a ConflictAppException. */
  private async onDispatchError(s: ScheduleRecord, error: unknown): Promise<Outcome> {
    if (error instanceof BudgetPausedException) {
      await this.record(s, 'schedule.tick_skipped', { reason: 'budget_paused' });
      return 'skipped';
    }
    if (error instanceof ConflictAppException) {
      await this.record(s, 'schedule.tick_skipped', { reason: 'active_job_elsewhere' });
      return 'skipped';
    }
    if (error instanceof NotFoundAppException || error instanceof FleetDispatchException || error instanceof ValidationAppException) {
      await this.disable(s, 'template_invalid', error.constructor.name);
      return 'disabled';
    }
    this.logger.error(`Schedule ${s.id} dispatch failed: ${messageOf(error)}`);
    // Plan D199: dispatch creates the job in its own transaction and only then places it and publishes. A failure in those
    // side effects leaves a QUEUED job this tick must still link. fire() found no active job before dispatching, so any
    // active job now is the one just created.
    const created = await this.repo.findActiveJob(s.id);
    if (created) {
      await this.linkDispatched(s, created.id, { sideEffectFailed: true });
      return 'dispatched';
    }
    await this.record(s, 'schedule.tick_skipped', { reason: 'error' });
    return 'skipped';
  }

  private async disable(s: ScheduleRecord, reason: AutoDisableReason, detail?: string): Promise<void> {
    await this.txManager.run(() => this.progress.disable(s.id, reason));
    if (detail) this.logger.warn(`Schedule ${s.id} disabled (${reason}): ${detail}`);
  }

  private record(s: ScheduleRecord, action: string, extra: Record<string, unknown>): Promise<void> {
    return this.activity.record({
      actorType: 'SYSTEM', actorId: SYSTEM_ACTOR_ID, action, entityType: 'schedule', entityId: s.id,
      jobId: typeof extra['jobId'] === 'string' ? extra['jobId'] : null, projectId: s.projectId, responsibleUserId: s.createdById,
      payload: schedulePayload(s, extra),
    });
  }
}
