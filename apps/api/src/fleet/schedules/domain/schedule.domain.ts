import type { FleetJobState } from '../../../common/enums';

export const SCHEDULE_REPOSITORY = Symbol('SCHEDULE_REPOSITORY');

export const SCHEDULE_DISABLED_REASONS = [
  'completed', 'finish_failed', 'no_progress', 'owner_lost_access', 'template_invalid', 'manual',
] as const;
export type ScheduleDisabledReason = (typeof SCHEDULE_DISABLED_REASONS)[number];
/** The reasons the system sets; `manual` is a user's own disable. */
export type AutoDisableReason = Exclude<ScheduleDisabledReason, 'manual'>;

export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export interface ScheduleRecord {
  id: string;
  projectId: string;
  /** No foreign key (plan D193): may name a repo that no longer exists. */
  repoId: string;
  name: string;
  cron: string;
  timezone: string;
  feature: string;
  ref: string;
  profiles: string[];
  /** Decimal as string. */
  maxCostUsd: string;
  selectorLabels: string[];
  /** No foreign key (plan D193). */
  pinnedRunnerId: string | null;
  enabled: boolean;
  nextFireAt: Date;
  lastFiredAt: Date | null;
  lastJobId: string | null;
  lastPassedCount: number;
  noProgressTicks: number;
  noProgressLimit: number;
  disabledReason: ScheduleDisabledReason | null;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewSchedule = Pick<
  ScheduleRecord,
  'projectId' | 'repoId' | 'name' | 'cron' | 'timezone' | 'feature' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels'
  | 'pinnedRunnerId' | 'noProgressLimit' | 'nextFireAt' | 'createdById'
>;

export type SchedulePatch = Partial<Pick<
  ScheduleRecord,
  'name' | 'cron' | 'timezone' | 'ref' | 'profiles' | 'maxCostUsd' | 'selectorLabels' | 'pinnedRunnerId' | 'enabled'
  | 'nextFireAt' | 'lastFiredAt' | 'lastJobId' | 'lastPassedCount' | 'noProgressTicks' | 'noProgressLimit'
  | 'disabledReason' | 'updatedById'
>>;

/** What the ticker needs to decide whether the owner may still dispatch (S1b §3.2, plan D201). */
export interface OwnerAccess {
  exists: boolean;
  disabled: boolean;
  /** `User.role`: MEMBER | ADMIN (empty when the user is gone). */
  globalRole: string;
  /** `ProjectMember.role` in the schedule's project, or null. */
  projectRole: string | null;
}

export interface ScheduleActiveJob {
  id: string;
  state: FleetJobState;
}

export interface IScheduleRepository {
  findById(id: string): Promise<ScheduleRecord | null>;
  /** SELECT … FOR UPDATE (inside txManager.run). */
  lockById(id: string): Promise<ScheduleRecord | null>;
  /** Oldest first. */
  findByProject(projectId: string): Promise<ScheduleRecord[]>;
  /** Enabled schedules with nextFireAt <= now, oldest due first, skipping soft-deleted projects (plan D207). */
  findDue(now: Date, limit: number): Promise<ScheduleRecord[]>;
  create(data: NewSchedule): Promise<ScheduleRecord>;
  update(id: string, patch: SchedulePatch): Promise<ScheduleRecord>;
  /** Detaches the schedule's jobs first (plan D194), then deletes the row. */
  delete(id: string): Promise<void>;
  /** Compare-and-set (S1b §3.2 step 2): true when this call moved nextFireAt off `expectedNextFireAt`. */
  claimFire(id: string, expectedNextFireAt: Date, nextFireAt: Date, now: Date): Promise<boolean>;
  /** The schedule's newest job in an active state, if any. */
  findActiveJob(scheduleId: string): Promise<ScheduleActiveJob | null>;
  /** Plan D200: one atomic UPDATE; the id of the QUEUED job that absorbed the tick, or null. */
  coalesceIntoQueued(scheduleId: string): Promise<string | null>;
  /** Plan D196: sets scheduleCountedAt when still null; true when this call claimed it. */
  claimCounted(jobId: string, now: Date): Promise<boolean>;
  findOwnerAccess(projectId: string, userId: string): Promise<OwnerAccess>;
  /** Sum of costSpentUsd + costCarriedUsd over each schedule's jobs, as 4-decimal strings; absent = no jobs. */
  sumCostBySchedule(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
