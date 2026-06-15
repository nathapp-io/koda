import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { WriteAgentActionInput } from '../koda-domain-writer/write-result.dto';
import type { AgentEventDomain } from './domain/events.domain';
import { PrismaEventsRepository } from './prisma-events.repository';

@Injectable()
export class AgentEventService {
  constructor(private readonly eventsRepo: PrismaEventsRepository) {}

  async create(data: WriteAgentActionInput): Promise<AgentEventDomain> {
    const project = await this.eventsRepo.findProject(data.projectId);

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'koda-domain-writer');
    }

    return this.eventsRepo.createAgentEvent(data);
  }
}
