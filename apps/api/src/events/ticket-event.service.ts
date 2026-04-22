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
      throw new ForbiddenAppException({ code: 'PROJECT_NOT_FOUND' }, 'koda-domain-writer');
    }

    const dataValue = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);

    const event = await this.prisma.client.ticketEvent.create({
      data: {
        ticketId: data.ticketId,
        projectId: data.projectId,
        action: data.action,
        actorId: data.actorId,
        actorType: data.actorType,
        source: data.source,
        data: dataValue,
        timestamp: new Date(),
      },
    });

    return event;
  }
}