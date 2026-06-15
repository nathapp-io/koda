import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { TicketSnapshot } from './domain/policy.domain';

@Injectable()
export class PrismaPolicyRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async findTicketById(ticketId: string): Promise<TicketSnapshot | null> {
    const ticket = await this.db.ticket.findUnique({
      where: { id: ticketId },
      select: { id: true, status: true, priority: true, title: true },
    });

    if (!ticket) return null;

    return {
      id: ticket.id,
      status: ticket.status,
      priority: ticket.priority,
      title: ticket.title,
    };
  }
}
