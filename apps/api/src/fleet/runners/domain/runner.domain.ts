import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { RunnerCapabilities } from '../../common/protocol';

export const RUNNER_REPOSITORY = Symbol('RUNNER_REPOSITORY');

export interface EnrollmentRecord {
  id: string;
  labels: string[];
  expiresAt: Date;
  usedAt: Date | null;
  runnerId: string | null;
  createdById: string;
  createdAt: Date;
}

export interface RunnerRecord {
  id: string;
  name: string;
  os: string;
  arch: string;
  labels: string[];
  capacity: number;
  capabilities: unknown;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  bootedAt: Date | null;
  enabled: boolean;
  lastSeenAt: Date;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewRunner {
  name: string;
  apiKeyHash: string;
  os: string;
  arch: string;
  labels: string[];
  capabilities: RunnerCapabilities;
  daemonVersion: string;
  protocolVersion: number;
  bootId: string;
  bootedAt: Date;
  lastSeenAt: Date;
  createdById: string;
}

export interface RunnerPatch {
  enabled?: boolean;
  labels?: string[];
  capacity?: number;
}

export interface IRunnerRepository {
  createEnrollment(data: { tokenHash: string; labels: string[]; expiresAt: Date; createdById: string }): Promise<EnrollmentRecord>;
  findEnrollmentPage(page: IPageOption): Promise<IPageResult<EnrollmentRecord>>;
  /** Atomically marks an unused, unexpired token used; null when none matched. */
  consumeEnrollment(tokenHash: string, now: Date): Promise<Pick<EnrollmentRecord, 'id' | 'labels' | 'createdById'> | null>;
  linkEnrollment(enrollmentId: string, runnerId: string): Promise<void>;
  /** #162: deletes consumed rows used before `before` and never-used rows that expired before it. */
  deleteSpentEnrollmentsBefore(before: Date): Promise<number>;
  /** Throws ConflictAppException(fleet.runners) on a duplicate name. */
  createRunner(data: NewRunner): Promise<RunnerRecord>;
  findRunnerById(id: string): Promise<RunnerRecord | null>;
  findRunnerPage(page: IPageOption): Promise<IPageResult<RunnerRecord>>;
  updateRunner(id: string, patch: RunnerPatch): Promise<RunnerRecord>;
  deleteRunner(id: string): Promise<void>;
  /** Number of the runner's jobs in an active state, as runner or as pin (plan D15). */
  countUnfinishedJobs(runnerId: string): Promise<number>;
  /** SELECT ... FOR UPDATE on the runner row, so the delete decision sees a stable row (review m6). */
  lockForDelete(id: string): Promise<void>;
}
