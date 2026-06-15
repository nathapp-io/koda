import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TicketLinkDomain } from './domain/ticket-link.domain';

@Injectable()
export class PrismaTicketLinkRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toDomain(m: any): TicketLinkDomain {
    return {
      id: m.id,
      ticketId: m.ticketId,
      url: m.url,
      provider: m.provider,
      externalRef: m.externalRef ?? null,
      prState: m.prState ?? null,
      prNumber: m.prNumber ?? null,
      prUpdatedAt: m.prUpdatedAt ?? null,
      linkType: m.linkType,
      createdAt: m.createdAt,
    };
  }

  async findProjectBySlug(slug: string): Promise<{ id: string } | null> {
    return this.db.project.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
  }

  async findTicketByNumber(
    projectId: string,
    number: number,
  ): Promise<{ id: string } | null> {
    return this.db.ticket.findFirst({
      where: { projectId, number, deletedAt: null },
      select: { id: true },
    });
  }

  async findTicketById(
    id: string,
    projectId: string,
  ): Promise<{ id: string } | null> {
    return this.db.ticket.findFirst({
      where: { id, projectId, deletedAt: null },
      select: { id: true },
    });
  }

  async findLinkByUrl(
    ticketId: string,
    url: string,
  ): Promise<TicketLinkDomain | null> {
    const m = await this.db.ticketLink.findFirst({
      where: { ticketId, url },
    });
    return m ? this.toDomain(m) : null;
  }

  async createLink(data: {
    ticketId: string;
    url: string;
    provider: string;
    externalRef: string | null;
    linkType: string;
  }): Promise<TicketLinkDomain> {
    const m = await this.db.ticketLink.create({ data });
    return this.toDomain(m);
  }

  async findLinksByTicket(ticketId: string): Promise<TicketLinkDomain[]> {
    const rows = await this.db.ticketLink.findMany({
      where: { ticketId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(m => this.toDomain(m));
  }

  async updateLink(
    id: string,
    data: { prState: string; prUpdatedAt: Date },
  ): Promise<void> {
    await this.db.ticketLink.update({ where: { id }, data });
  }

  async findLinkByIdAndTicket(
    id: string,
    ticketId: string,
  ): Promise<TicketLinkDomain | null> {
    const m = await this.db.ticketLink.findFirst({
      where: { id, ticketId },
    });
    return m ? this.toDomain(m) : null;
  }

  async deleteLink(id: string): Promise<void> {
    await this.db.ticketLink.delete({ where: { id } });
  }

  async findByPrNumber(
    prNumber: number,
    projectId: string,
  ): Promise<TicketLinkDomain | null> {
    const m = await this.db.ticketLink.findFirst({
      where: { prNumber, ticket: { projectId } },
    });
    return m ? this.toDomain(m) : null;
  }
}
