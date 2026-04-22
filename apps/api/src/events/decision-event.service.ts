import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';

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
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async create(data: CreateDecisionEventInput) {
    const project = await this.prisma.client.project.findUnique({
      where: { id: data.projectId },
    });

    if (!project) {
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'koda-domain-writer');
    }

    const event = await this.prisma.client.decisionEvent.create({
      data: {
        projectId: data.projectId,
        agentId: data.agentId,
        action: data.action,
        decision: data.decision,
        rationale: data.rationale,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });

    return event;
  }
}