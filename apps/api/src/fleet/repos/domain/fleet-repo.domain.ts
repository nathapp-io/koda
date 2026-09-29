import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const FLEET_REPO_REPOSITORY = Symbol('FLEET_REPO_REPOSITORY');

export interface FleetRepoRecord {
  id: string;
  projectId: string;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  githubInstallationId: bigint | null;
  createdById: string;
  createdAt: Date;
}

export interface IFleetRepoRepository {
  findProject(slug: string): Promise<{ id: string; slug: string } | null>;
  /** Throws ConflictAppException(fleet.repos) on a duplicate (provider, owner, name). */
  create(data: Omit<FleetRepoRecord, 'id' | 'createdAt'>): Promise<FleetRepoRecord>;
  findById(id: string): Promise<FleetRepoRecord | null>;
  findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>>;
  delete(id: string): Promise<void>;
  /** Number of the repo's jobs in an active state (plan D15). */
  countUnfinishedJobs(repoId: string): Promise<number>;
  /** SELECT ... FOR UPDATE on the repo row, so the delete decision sees a stable row (review m6). */
  lockForDelete(id: string): Promise<void>;
}
