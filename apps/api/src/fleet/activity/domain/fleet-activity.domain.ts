import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { FleetActorType } from '../../../common/enums';

export const FLEET_ACTIVITY_REPOSITORY = Symbol('FLEET_ACTIVITY_REPOSITORY');

/**
 * The activity feed's entity types. `FleetEntityType` derives from this list so the members are also
 * readable at runtime (a feed filter or a test can name them); the order is the order they arrived in,
 * and C10 US-003 appends `provider_credential` without touching the nine before it.
 */
export const FLEET_ENTITY_TYPES = [
  'runner',
  'enrollment',
  'repo',
  'job',
  'budget',
  'schedule',
  'approval',
  'ingest',
  'analytics',
  'provider_credential',
  'flow',
] as const;

export type FleetEntityType = (typeof FLEET_ENTITY_TYPES)[number];

export interface FleetActivityEntry {
  actorType: FleetActorType;
  actorId: string;
  action: string;
  entityType: FleetEntityType;
  entityId: string;
  jobId?: string | null;
  projectId?: string | null;
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
  projectId: string | null;
  responsibleUserId: string | null;
  payload: unknown;
  createdAt: Date;
}

export interface FleetActivityFilters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  jobId?: string;
  /** undefined = no scope (global ADMIN); otherwise only rows in these projects. */
  projectIds?: readonly string[];
}

export interface IFleetActivityRepository {
  create(row: Required<Omit<FleetActivityEntry, 'payload'>> & { payload: Record<string, unknown> }): Promise<void>;
  findPage(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityRecord>>;
}
