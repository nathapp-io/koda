import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { WriteTicketEventInput } from '../koda-domain-writer/write-result.dto';
import type { TicketEventDomain } from './domain/events.domain';
import { PrismaEventsRepository } from './prisma-events.repository';

@Injectable()
export class TicketEventService {
  constructor(private readonly eventsRepo: PrismaEventsRepository) {}

  async create(data: WriteTicketEventInput): Promise<TicketEventDomain> {
    const project = await this.eventsRepo.findProject(data.projectId);

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'koda-domain-writer');
    }

    return this.eventsRepo.createTicketEvent(data);
  }
}
