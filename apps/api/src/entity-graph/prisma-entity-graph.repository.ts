import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import type {
  GraphLinkRecord,
  GraphNodeRecord,
  IEntityGraphRepository,
  TicketWithLabelsAndLinks,
} from './domain/entity-graph.domain';

@Injectable()
export class PrismaEntityGraphRepository implements IEntityGraphRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  async findTicketsWithLabelsAndLinks(projectId: string): Promise<TicketWithLabelsAndLinks[]> {
    return this.prisma.client.ticket.findMany({
      where: { projectId, deletedAt: null },
      include: { labels: { include: { label: true } }, links: true },
    }) as unknown as Promise<TicketWithLabelsAndLinks[]>;
  }

  async findGraphNodesByType(projectId: string, type: string): Promise<GraphNodeRecord[]> {
    return this.prisma.client.graphNode.findMany({
      where: { projectId, type },
    }) as unknown as Promise<GraphNodeRecord[]>;
  }

  async findGraphLinksByRelation(projectId: string, relation: string): Promise<GraphLinkRecord[]> {
    return this.prisma.client.graphLink.findMany({
      where: { projectId, relation },
    }) as unknown as Promise<GraphLinkRecord[]>;
  }
}
