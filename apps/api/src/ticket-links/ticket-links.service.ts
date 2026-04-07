import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import { detectProvider } from '../common/utils/detect-provider.util';

export interface CreateTicketLinkResult {
  status: 200 | 201;
  link: TicketLinkResponseDto;
}

@Injectable()
export class TicketLinksService {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private async resolveTicket(slug: string, ref: string) {
    const project = await this.db.project.findFirst({
      where: { slug, deletedAt: null },
    });

    if (!project) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    const refMatch = ref.match(/^([A-Z]+)-(\d+)$/);
    let ticket: Awaited<ReturnType<typeof this.db.ticket.findFirst>>;

    if (refMatch) {
      const number = parseInt(refMatch[2], 10);
      ticket = await this.db.ticket.findFirst({
        where: { projectId: project.id, number, deletedAt: null },
      });
    } else {
      ticket = await this.db.ticket.findFirst({
        where: { id: ref, projectId: project.id, deletedAt: null },
      });
    }

    if (!ticket) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    return ticket;
  }

  async create(
    slug: string,
    ref: string,
    dto: CreateTicketLinkDto,
  ): Promise<CreateTicketLinkResult> {
    const ticket = await this.resolveTicket(slug, ref);

    const existing = await this.db.ticketLink.findFirst({
      where: { ticketId: ticket.id, url: dto.url },
    });

    if (existing) {
      return { status: 200, link: TicketLinkResponseDto.from(existing) };
    }

    const { provider, externalRef } = detectProvider(dto.url);

    const link = await this.db.ticketLink.create({
      data: {
        ticketId: ticket.id,
        url: dto.url,
        provider,
        externalRef,
        linkType: dto.linkType ?? 'url',
      },
    });

    return { status: 201, link: TicketLinkResponseDto.from(link) };
  }

  async findByTicket(slug: string, ref: string): Promise<TicketLinkResponseDto[]> {
    const ticket = await this.resolveTicket(slug, ref);

    const links = await this.db.ticketLink.findMany({
      where: { ticketId: ticket.id },
      orderBy: { createdAt: 'asc' },
    });

    return TicketLinkResponseDto.fromMany(links);
  }

  /**
   * Update TicketLink.prState from a pull_request webhook event.
   * Used by VcsWebhookService when handling pull_request events.
   */
  async updatePrStateFromWebhook(
    linkId: string,
    state: string,
  ): Promise<void> {
    await this.db.ticketLink.update({
      where: { id: linkId },
      data: { prState: state, prUpdatedAt: new Date() },
    });
  }

  /**
   * Find a TicketLink by PR number and project ID.
   * Used by VcsWebhookService to match pull_request webhook events to TicketLinks.
   */
  async findByPrNumber(prNumber: number, projectId: string) {
    return this.db.ticketLink.findFirst({
      where: {
        prNumber,
        ticket: { projectId },
      },
    });
  }

  /**
   * Stub for webhook actions that should be ignored.
   * No update occurs; this is a no-op placeholder for dispatcher routing.
   */
  async updatePrStateFromIgnoredAction(
    _linkId: string,
    _action: string,
  ): Promise<void> {
    // No-op: these actions do not update TicketLink state
  }

  async remove(slug: string, ref: string, linkId: string): Promise<void> {
    const ticket = await this.resolveTicket(slug, ref);

    const link = await this.db.ticketLink.findFirst({
      where: { id: linkId, ticketId: ticket.id },
    });

    if (!link) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    await this.db.ticketLink.delete({ where: { id: linkId } });
  }
}
