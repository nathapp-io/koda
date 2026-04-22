import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';
import type { WriteAgentActionInput } from '../koda-domain-writer/write-result.dto';

@Injectable()
export class AgentEventService {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async create(data: WriteAgentActionInput) {
    const project = await this.prisma.client.project.findUnique({
      where: { id: data.projectId },
    });

    if (!project) {
      throw new ForbiddenAppException({}, 'koda-domain-writer');
    }

    const event = await this.prisma.client.agentEvent.create({
      data: {
        agentId: data.agentId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });

    return event;
  }
}