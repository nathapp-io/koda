import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { BashMode } from '../common/protocol';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { normalizeDispatch } from '../jobs/dispatch-input';
import { FleetDispatchException } from '../jobs/fleet-dispatch.exception';
import { PERMANENT_MISFITS } from '../jobs/placement-rules';
import { PlacementService, toPlacementJob } from '../jobs/placement.service';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { assertCronAllowed, CronInputError, MIN_FIRE_GAP_MS, nextFireAfter } from './cron-schedule';
import { DEFAULT_NO_PROGRESS_LIMIT, IScheduleRepository, SCHEDULE_REPOSITORY, ScheduleRecord } from './domain/schedule.domain';
import type { CreateScheduleDto } from './dto/create-schedule.dto';
import { ScheduleDto } from './dto/schedule.dto';
import type { UpdateScheduleDto } from './dto/update-schedule.dto';
import { schedulePayload } from './schedule-payloads';
import { mayDispatch } from './schedule-access';

const ZERO_USD = '0.0000';

/** The template fields a create or an edit must validate together. */
interface TemplateInput {
  repoId: string;
  feature: string;
  cron: string;
  timezone: string;
  ref?: string;
  profiles?: string[];
  maxCostUsd: number;
  selectorLabels?: string[];
  pinnedRunnerId?: string | null;
  bashMode?: BashMode;
  approvalTimeoutSec?: number;
}

interface CheckedTemplate {
  repoId: string;
  feature: string;
  cron: string;
  timezone: string;
  ref: string;
  profiles: string[];
  maxCostUsd: string;
  selectorLabels: string[];
  pinnedRunnerId: string | null;
  bashMode: BashMode;
  approvalTimeoutSec: number;
}

/** Plan D191: a cron or zone refusal is a 400; too frequent has its own code. */
function cronProblem(error: unknown): Error {
  if (!(error instanceof CronInputError)) return error instanceof Error ? error : new Error(String(error));
  if (error.failure === 'too_frequent') return new ValidationAppException({ minutes: MIN_FIRE_GAP_MS / 60_000 }, 'fleet.scheduleCronTooFrequent');
  return new ValidationAppException({ reason: error.message }, 'fleet.scheduleInput');
}

/**
 * S1b §3.4: schedule management. Who may call is the controller's job (create: DEVELOPER+; mutations: DEVELOPER+
 * through CASL); `canAdminister` (project ADMIN, which a global ADMIN resolves to) is the other half of "owner or
 * project ADMIN" and is checked here under the row lock (plan D202).
 */
@Injectable()
export class SchedulesService {
  constructor(
    @Inject(SCHEDULE_REPOSITORY) private readonly repo: IScheduleRepository,
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobsRepo: Pick<IFleetJobRepository, 'findRepo'>,
    private readonly placement: PlacementService,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async list(projectId: string): Promise<ScheduleDto[]> {
    const rows = await this.repo.findByProject(projectId);
    const costs = await this.repo.sumCostBySchedule(rows.map((r) => r.id));
    return rows.map((r) => ScheduleDto.from(r, costs.get(r.id) ?? ZERO_USD));
  }

  async get(projectId: string, id: string): Promise<ScheduleDto> {
    const schedule = await this.repo.findById(id);
    if (!schedule || schedule.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.schedules');
    return this.toDto(schedule);
  }

  async create(actorId: string, projectId: string, dto: CreateScheduleDto, now = new Date()): Promise<ScheduleDto> {
    const t = await this.checkTemplate(projectId, dto, now);
    const created = await this.txManager.run(async () => {
      const schedule = await this.repo.create({
        projectId, repoId: t.repoId, name: dto.name.trim(), cron: t.cron, timezone: t.timezone, feature: t.feature, ref: t.ref,
        profiles: t.profiles, maxCostUsd: t.maxCostUsd, selectorLabels: t.selectorLabels, pinnedRunnerId: t.pinnedRunnerId,
        bashMode: t.bashMode, approvalTimeoutSec: t.approvalTimeoutSec,
        noProgressLimit: dto.noProgressLimit ?? DEFAULT_NO_PROGRESS_LIMIT, nextFireAt: nextFireAfter(t.cron, t.timezone, now), createdById: actorId,
      });
      await this.record(actorId, 'schedule.created', schedule);
      return schedule;
    });
    return this.toDto(created);
  }

  async update(actorId: string, projectId: string, id: string, dto: UpdateScheduleDto, canAdminister: boolean, now = new Date()): Promise<ScheduleDto> {
    const updated = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      // The whole template is re-validated, not only the changed fields: a schedule that cannot dispatch is refused
      // here instead of being disabled by the next tick.
      const t = await this.checkTemplate(projectId, {
        repoId: current.repoId, feature: current.feature, cron: dto.cron ?? current.cron, timezone: dto.timezone ?? current.timezone,
        ref: dto.ref ?? current.ref, profiles: dto.profiles ?? current.profiles, maxCostUsd: dto.maxCostUsd ?? Number(current.maxCostUsd),
        selectorLabels: dto.selectorLabels ?? current.selectorLabels,
        pinnedRunnerId: dto.pinnedRunnerId === undefined ? current.pinnedRunnerId : dto.pinnedRunnerId,
        bashMode: dto.bashMode ?? current.bashMode, approvalTimeoutSec: dto.approvalTimeoutSec ?? current.approvalTimeoutSec,
      }, now);
      const moved = (dto.cron !== undefined || dto.timezone !== undefined) && current.enabled;
      const after = await this.repo.update(id, {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        cron: t.cron, timezone: t.timezone, ref: t.ref, profiles: t.profiles, maxCostUsd: t.maxCostUsd,
        selectorLabels: t.selectorLabels, pinnedRunnerId: t.pinnedRunnerId, bashMode: t.bashMode, approvalTimeoutSec: t.approvalTimeoutSec,
        ...(dto.noProgressLimit !== undefined ? { noProgressLimit: dto.noProgressLimit } : {}),
        ...(moved ? { nextFireAt: nextFireAfter(t.cron, t.timezone, now) } : {}),
        updatedById: actorId,
      });
      await this.record(actorId, 'schedule.updated', after);
      return after;
    });
    return this.toDto(updated);
  }

  async remove(actorId: string, projectId: string, id: string, canAdminister: boolean): Promise<void> {
    await this.txManager.run(async () => {
      // Plan D194: no schedule lock here. delete() locks the job rows first, then the schedule row, the order a job's end uses.
      const current = this.assertManaged(await this.repo.findById(id), projectId, actorId, canAdminister);
      await this.repo.delete(id);
      await this.record(actorId, 'schedule.deleted', current);
    });
  }

  /** S1b §3.3: re-enabling resets the stall counter and the reason, recomputes nextFireAt from now, keeps lastPassedCount. 409 when the owner can no longer dispatch (D211). */
  async enable(actorId: string, projectId: string, id: string, canAdminister: boolean, now = new Date()): Promise<ScheduleDto> {
    const result = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      if (current.enabled) return current;
      // Plan D211: the owner must still be able to dispatch, or the next tick would disable the schedule again.
      if (!mayDispatch(await this.repo.findOwnerAccess(projectId, current.createdById))) {
        throw new ConflictAppException({}, 'fleet.scheduleOwnerNoAccess');
      }
      const after = await this.repo.update(id, {
        enabled: true, disabledReason: null, noProgressTicks: 0, nextFireAt: nextFireAfter(current.cron, current.timezone, now), updatedById: actorId,
      });
      await this.record(actorId, 'schedule.enabled', after, { previousReason: current.disabledReason });
      return after;
    });
    return this.toDto(result);
  }

  async disable(actorId: string, projectId: string, id: string, canAdminister: boolean): Promise<ScheduleDto> {
    const result = await this.txManager.run(async () => {
      const current = await this.lockManaged(projectId, id, actorId, canAdminister);
      if (!current.enabled) return current;
      const after = await this.repo.update(id, { enabled: false, disabledReason: 'manual', updatedById: actorId });
      await this.record(actorId, 'schedule.disabled', after, { reason: 'manual' });
      return after;
    });
    return this.toDto(result);
  }

  /** S1b §3.1: the cron rules, the dispatch rules and the repo and runner checks, in the order dispatch applies them. */
  private async checkTemplate(projectId: string, input: TemplateInput, now: Date): Promise<CheckedTemplate> {
    let zoned: { cron: string; timezone: string };
    try {
      zoned = assertCronAllowed(input.cron, input.timezone, now);
    } catch (error) {
      throw cronProblem(error);
    }
    const repo = await this.jobsRepo.findRepo(input.repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    const normalized = normalizeDispatch({
      repoId: input.repoId, command: 'RUN', feature: input.feature, maxCostUsd: input.maxCostUsd,
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
      ...(input.profiles !== undefined ? { profiles: input.profiles } : {}),
      ...(input.selectorLabels !== undefined ? { selectorLabels: input.selectorLabels } : {}),
      ...(input.pinnedRunnerId ? { pinnedRunnerId: input.pinnedRunnerId } : {}),
      ...(input.bashMode !== undefined ? { bashMode: input.bashMode } : {}),
      ...(input.approvalTimeoutSec !== undefined ? { approvalTimeoutSec: input.approvalTimeoutSec } : {}),
    }, repo.defaultBranch);
    if (normalized.pinnedRunnerId) {
      const verdict = await this.placement.evaluatePinned(normalized.pinnedRunnerId, toPlacementJob(normalized, repo));
      if (verdict === 'not_found') throw new NotFoundAppException({}, 'fleet.runners');
      if (verdict !== null && PERMANENT_MISFITS.has(verdict)) throw new FleetDispatchException(verdict);
    }
    return {
      repoId: input.repoId, feature: normalized.feature, cron: zoned.cron, timezone: zoned.timezone, ref: normalized.ref,
      profiles: normalized.profiles, maxCostUsd: normalized.maxCostUsd, selectorLabels: normalized.selectorLabels, pinnedRunnerId: normalized.pinnedRunnerId,
      bashMode: normalized.bashMode, approvalTimeoutSec: normalized.approvalTimeoutSec,
    };
  }

  /** Under the row lock (update, enable, disable touch no job rows): see assertManaged. */
  private async lockManaged(projectId: string, id: string, actorId: string, canAdminister: boolean): Promise<ScheduleRecord> {
    return this.assertManaged(await this.repo.lockById(id), projectId, actorId, canAdminister);
  }

  /** 404 for a missing schedule or another project's, 403 unless the owner or a project ADMIN. */
  private assertManaged(schedule: ScheduleRecord | null, projectId: string, actorId: string, canAdminister: boolean): ScheduleRecord {
    if (!schedule || schedule.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.schedules');
    if (!canAdminister && schedule.createdById !== actorId) throw new ForbiddenAppException({}, 'projects');
    return schedule;
  }

  private async toDto(schedule: ScheduleRecord): Promise<ScheduleDto> {
    const costs = await this.repo.sumCostBySchedule([schedule.id]);
    return ScheduleDto.from(schedule, costs.get(schedule.id) ?? ZERO_USD);
  }

  private record(actorId: string, action: string, schedule: ScheduleRecord, extra: Record<string, unknown> = {}): Promise<void> {
    return this.activity.record({
      actorType: 'USER', actorId, action, entityType: 'schedule', entityId: schedule.id, projectId: schedule.projectId,
      responsibleUserId: actorId, payload: schedulePayload(schedule, extra),
    });
  }
}
