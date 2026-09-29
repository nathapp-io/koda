import { Inject, Injectable } from '@nestjs/common';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import {
  FLEET_ACTIVITY_REPOSITORY,
  FleetActivityEntry,
  FleetActivityFilters,
  IFleetActivityRepository,
} from './domain/fleet-activity.domain';
import { FleetActivityDto } from './dto/fleet-activity.dto';

const SECRET_KEY = /token|secret|key|password|credential/i;

@Injectable()
export class FleetActivityService {
  constructor(@Inject(FLEET_ACTIVITY_REPOSITORY) private readonly repo: IFleetActivityRepository) {}

  /** Call inside the mutating txManager.run so the row commits or rolls back with it (spec §8). */
  async record(entry: FleetActivityEntry): Promise<void> {
    const payload = entry.payload ?? {};
    if (Object.keys(payload).some((k) => SECRET_KEY.test(k))) {
      throw new Error('activity payload must not contain secrets');
    }
    await this.repo.create({
      actorType: entry.actorType,
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
}
