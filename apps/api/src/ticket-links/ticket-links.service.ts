import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import { detectProvider } from '../common/utils/detect-provider.util';
import { PrismaTicketLinkRepository } from './prisma-ticket-link.repository';
import { TicketLinkDomain } from './domain/ticket-link.domain';

export interface CreateTicketLinkResult {
  status: 200 | 201;
  link: TicketLinkResponseDto;
}

@Injectable()
export class TicketLinksService {
  constructor(private readonly repo: PrismaTicketLinkRepository) {}

  private async resolveTicket(
    slug: string,
    ref: string,
  ): Promise<{ id: string }> {
    const project = await this.repo.findProjectBySlug(slug);

    if (!project) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    const refMatch = ref.match(/^([A-Z]+)-(\d+)$/);
    let ticket: { id: string } | null;

    if (refMatch) {
      const number = parseInt(refMatch[2], 10);
      ticket = await this.repo.findTicketByNumber(project.id, number);
    } else {
      ticket = await this.repo.findTicketById(ref, project.id);
    }

    if (!ticket) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    return ticket;
  }

  private inferLinkType(url: string, explicitLinkType?: string): string {
    if (explicitLinkType) {
      return explicitLinkType;
    }

    if (
      /\/pull\/\d+/.test(url) ||
      /\/merge_requests\/\d+/.test(url) ||
      /\/pull-requests\/\d+/.test(url)
    ) {
      return 'pr';
    }

    return 'url';
  }

  async create(
    slug: string,
    ref: string,
    dto: CreateTicketLinkDto,
  ): Promise<CreateTicketLinkResult> {
    const ticket = await this.resolveTicket(slug, ref);

    const existing = await this.repo.findLinkByUrl(ticket.id, dto.url);

    if (existing) {
      return { status: 200, link: TicketLinkResponseDto.from(existing) };
    }

    const { provider, externalRef } = detectProvider(dto.url);

    const link = await this.repo.createLink({
      ticketId: ticket.id,
      url: dto.url,
      provider,
      externalRef,
      linkType: this.inferLinkType(dto.url, dto.linkType),
    });

    return { status: 201, link: TicketLinkResponseDto.from(link) };
  }

  async findByTicket(
    slug: string,
    ref: string,
  ): Promise<TicketLinkResponseDto[]> {
    const ticket = await this.resolveTicket(slug, ref);

    const links = await this.repo.findLinksByTicket(ticket.id);

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
    await this.repo.updateLink(linkId, { prState: state, prUpdatedAt: new Date() });
  }

  /**
   * Find a TicketLink by PR number and project ID.
   * Used by VcsWebhookService to match pull_request webhook events to TicketLinks.
   */
  async findByPrNumber(
    prNumber: number,
    projectId: string,
  ): Promise<TicketLinkDomain | null> {
    return this.repo.findByPrNumber(prNumber, projectId);
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

    const link = await this.repo.findLinkByIdAndTicket(linkId, ticket.id);

    if (!link) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    await this.repo.deleteLink(linkId);
  }
}
