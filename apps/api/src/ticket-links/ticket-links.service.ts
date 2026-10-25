import { Injectable } from '@nestjs/common';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateTicketLinkDto } from './dto/create-ticket-link.dto';
import { TicketLinkResponseDto } from './dto/ticket-link-response.dto';
import { detectProvider } from '../common/utils/detect-provider.util';
import { parseTicketRef } from '../common/utils/ticket-ref.util';
import { PrismaTicketLinkRepository } from './prisma-ticket-link.repository';
import { TicketLinkDomain } from './domain/ticket-link.domain';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import { PermissionService } from '../permissions/permission.service';
import type { PrincipalRef } from '../permissions/permissions.types';
import { AuditRecorder } from '../audit/audit-recorder.service';

export interface CreateTicketLinkResult {
  status: 200 | 201;
  link: TicketLinkResponseDto;
}

/** The key a removal is checked against, in its full and `.own` forms (`PermissionService.can`). */
const REMOVE_KEY = 'ticket.link.remove';

@Injectable()
export class TicketLinksService {
  constructor(
    private readonly repo: PrismaTicketLinkRepository,
    private readonly permissions: PermissionService,
    private readonly audit: AuditRecorder,
  ) {}

  private async resolveTicket(
    slug: string,
    ref: string,
  ): Promise<{ id: string; projectId: string; ref: string }> {
    const project = await this.repo.findProjectBySlug(slug);

    if (!project) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    // H5: same scoped predicate as findTicketScoped — a KEY-N ref whose
    // prefix differs from the project's key never resolves locally, even
    // when the project happens to own the same ticket number. CUID refs are
    // already project-scoped by findTicketById.
    const parsed = parseTicketRef(ref);
    let ticket: { id: string; number: number } | null;

    if (parsed) {
      const found = parsed.prefix === project.key
        ? await this.repo.findTicketByNumber(project.id, parsed.number)
        : null;
      ticket = found ? { ...found, number: parsed.number } : null;
    } else {
      ticket = await this.repo.findTicketById(ref, project.id);
    }

    if (!ticket) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    return {
      id: ticket.id,
      projectId: project.id,
      ref: `${project.key}-${parsed?.number ?? ticket.number}`,
    };
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

  /**
   * Adds a link to a ticket, or returns the existing one for the same URL (status 200).
   *
   * `createdBy` is optional on purpose: the REST route passes its caller, while the assistant link
   * tool, the VCS writer and the fleet writer pass nothing. A creatorless link can be removed only by
   * a principal holding the full `ticket.link.remove` key. An existing link is never rewritten, so the
   * first person to add a URL keeps ownership of it.
   */
  async create(
    slug: string,
    ref: string,
    dto: CreateTicketLinkDto,
    createdBy?: PrincipalRef,
  ): Promise<CreateTicketLinkResult> {
    const ticket = await this.resolveTicket(slug, ref);

    const existing = await this.repo.findLinkByUrl(ticket.id, dto.url);

    if (existing) {
      return { status: 200, link: TicketLinkResponseDto.from(existing) };
    }

    const { provider, externalRef } = detectProvider(dto.url);

    const link = await this.audit.audited(
      () => this.repo.createLink({
        ticketId: ticket.id,
        url: dto.url,
        provider,
        externalRef,
        linkType: this.inferLinkType(dto.url, dto.linkType),
        createdByUserId: createdBy?.type === 'USER' ? createdBy.id : null,
        createdByAgentId: createdBy?.type === 'AGENT' ? createdBy.id : null,
      }),
      (created) => ({
        key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: created.id,
        projectId: ticket.projectId, summary: `on ${ticket.ref}`,
      }),
    );

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
   * Removes one link from a ticket.
   *
   * The lookup comes first, so an unknown link stays a `ticket-links` 404 whatever the caller holds.
   * The check is the row-level half of `ticket.link.remove`: a principal holding `X.own` may remove
   * only a link it created, and a creatorless link (null creator) satisfies no owner comparison, so
   * only the full key removes it.
   */
  async remove(
    slug: string,
    ref: string,
    linkId: string,
    principal: KodaPrincipal,
  ): Promise<void> {
    const ticket = await this.resolveTicket(slug, ref);

    const link = await this.repo.findLinkByIdAndTicket(linkId, ticket.id);

    if (!link) {
      throw new NotFoundAppException({}, 'ticket-links');
    }

    const decision = await this.permissions.can(principal, REMOVE_KEY, {
      projectId: ticket.projectId,
      resource: { createdBy: linkCreator(link) },
    });

    if (!decision.allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }

    await this.audit.audited(
      async () => {
        await this.repo.deleteLink(linkId);
        return linkId;
      },
      (id) => ({
        key: 'ticket.link.remove', resourceType: 'ticket-link', resourceId: id,
        projectId: ticket.projectId, summary: `from ${ticket.ref}`,
      }),
    );
  }
}

/** Who added the link, as `PermissionService.can` compares it for an `.own` key. */
function linkCreator(link: TicketLinkDomain): PrincipalRef | null {
  if (link.createdByUserId) return { type: 'USER', id: link.createdByUserId };
  if (link.createdByAgentId) return { type: 'AGENT', id: link.createdByAgentId };
  return null;
}
