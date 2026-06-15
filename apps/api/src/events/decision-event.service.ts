import { Injectable } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { DecisionEventDomain } from './domain/events.domain';
import { PrismaEventsRepository } from './prisma-events.repository';

export interface CreateDecisionEventInput {
  projectId: string;
  agentId: string;
  action: string;
  decision: 'approved' | 'rejected' | 'escalated';
  rationale: string | null;
  source: 'api' | 'internal' | 'webhook';
  data: Record<string, unknown>;
}

@Injectable()
export class DecisionEventService {
  constructor(private readonly eventsRepo: PrismaEventsRepository) {}

  async create(data: CreateDecisionEventInput): Promise<DecisionEventDomain> {
    const project = await this.eventsRepo.findProject(data.projectId);

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'koda-domain-writer');
    }

    return this.eventsRepo.createDecisionEvent(data);
  }
}
