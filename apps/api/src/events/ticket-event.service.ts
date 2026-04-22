import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import type { PrismaClient } from '@prisma/client';
import type { WriteTicketEventInput } from '../koda-domain-writer/write-result.dto';

@Injectable()
export class TicketEventService {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async create(data: WriteTicketEventInput) {
    const project = await this.prisma.client.project.findUnique({
      where: { id: data.projectId },
    });

    if (!project) {
      throw new ForbiddenAppException({}, 'koda-domain-writer');
    }

    const event = await this.prisma.client.ticketEvent.create({
      data: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: JSON.stringify(data.data),
        timestamp: new Date(),
      },
    });

    return event;
  }
}