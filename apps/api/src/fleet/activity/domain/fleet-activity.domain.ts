import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActorType } from '../../../common/enums';

export const FLEET_ACTIVITY_REPOSITORY = Symbol('FLEET_ACTIVITY_REPOSITORY');

export type FleetEntityType = 'runner' | 'enrollment' | 'repo';

export interface FleetActivityEntry {
  actorType: FleetActorType;
  actorId: string;
  action: string;
  entityType: FleetEntityType;
  entityId: string;
  jobId?: string | null;
  responsibleUserId?: string | null;
  payload?: Record<string, unknown>;
}

export interface FleetActivityRecord {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  jobId: string | null;
  responsibleUserId: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface FleetActivityFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
}

export interface IFleetActivityRepository {
  create(row: Required<Omit<FleetActivityEntry, 'payload'>> & { payload: Record<string, unknown> }): Promise<void>;
  findPage(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityRecord>>;
}
