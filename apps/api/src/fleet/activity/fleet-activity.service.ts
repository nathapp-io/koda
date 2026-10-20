import { Inject, Injectable } from '@nestjs/common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { actorTypeFor } from '../../action-context/action-context';
import { FleetActorType } from '../../common/enums';
import { remapPage } from '../../common/dto/koda-page.query';
import {
  FLEET_ACTIVITY_REPOSITORY,
  FleetActivityEntry,
  FleetActivityFilters,
  IFleetActivityRepository,
} from './domain/fleet-activity.domain';
import { FleetActivityDto } from './dto/fleet-activity.dto';

export const FLEET_ACTIVITY_SECRET_KEY = /token|secret|key|password|credential/i;

@Injectable()
export class FleetActivityService {
  constructor(@Inject(FLEET_ACTIVITY_REPOSITORY) private readonly repo: IFleetActivityRepository) {}

  /** Call inside the mutating txManager.run so the row commits or rolls back with it (spec §8). */
  async record(entry: FleetActivityEntry): Promise<void> {
    const payload = entry.payload ?? {};
    if (Object.keys(payload).some((k) => FLEET_ACTIVITY_SECRET_KEY.test(k))) {
      throw new Error('activity payload must not contain secrets');
    }
    await this.repo.create({
      actorType: this.actorTypeOf(entry),
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      jobId: entry.jobId ?? null,
      projectId: entry.projectId ?? null,
      responsibleUserId: entry.responsibleUserId ?? null,
      payload,
    });
  }

  async list(filters: FleetActivityFilters, page: IPageOption): Promise<IPageResult<FleetActivityDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetActivityDto.from);
  }

  /** Project ids the user is a member of, for activity scoping (plan D14). */
  memberProjectIds(userId: string): Promise<string[]> {
    return this.repo.findMemberProjectIds(userId);
  }

  /**
   * The actor type to store. A `USER` entry whose id is the acting principal's is written with that
   * principal's type, so the ~50 fleet call sites that pass `'USER'` keep working and an agent's write
   * is labelled `AGENT` — while a `SYSTEM`/`RUNNER` entry, or a `USER` entry about someone else (a
   * schedule owner, a job requester), keeps the type its caller gave it. Outside any request context
   * `actorTypeFor` answers `USER`, so a write with no context is unchanged.
   */
  private actorTypeOf(entry: FleetActivityEntry): FleetActorType {
    return entry.actorType === FleetActorType.USER ? actorTypeFor(entry.actorId) : entry.actorType;
  }
}
