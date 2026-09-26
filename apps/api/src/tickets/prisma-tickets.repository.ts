import { Injectable } from '@nestjs/common';
import { PrismaService, Paginate } from '@nathapp/nestjs-prisma';
import { PrismaClient, Prisma } from '@prisma/client';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { parseTicketRef } from '../common/utils/ticket-ref.util';
import type {
  ITicketRepository,
  TicketProject,
  TicketDomain,
  TicketListFilters,
  CreateTicketData,
  UpdateTicketData,
  AssignTicketData,
} from './domain/ticket.domain';

// ---------------------------------------------------------------------------
// Local row types — what Prisma actually returns for queries with includes
// ---------------------------------------------------------------------------

type PrismaTicketLinkRow = {
  id: string;
  ticketId: string;
  url: string;
  provider: string;
  externalRef: string | null;
  prState: string | null;
  prNumber: number | null;
  prUpdatedAt: Date | null;
  linkType: string;
  createdAt: Date;
};

type PrismaTicketLabelRow = {
  ticketId: string;
  labelId: string;
  label: {
    id: string;
    name: string;
    color: string;
    projectId: string;
  };
};

type PrismaTicketRow = {
  id: string;
  projectId: string;
  number: number;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignedToUserId: string | null;
  assignedToAgentId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  gitRefVersion: string | null;
  gitRefFile: string | null;
  gitRefLine: number | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  labels?: PrismaTicketLabelRow[];
  links?: PrismaTicketLinkRow[];
};

@Injectable()
export class PrismaTicketsRepository implements ITicketRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  private toDomain(row: PrismaTicketRow): TicketDomain {
    return {
      id: row.id,
      projectId: row.projectId,
      number: row.number,
      type: row.type,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignedToUserId: row.assignedToUserId,
      assignedToAgentId: row.assignedToAgentId,
      createdByUserId: row.createdByUserId,
      createdByAgentId: row.createdByAgentId,
      gitRefVersion: row.gitRefVersion,
      gitRefFile: row.gitRefFile,
      gitRefLine: row.gitRefLine,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      labels: row.labels?.map((tl) => ({
        label: {
          id: tl.label.id,
          name: tl.label.name,
          color: tl.label.color,
        },
      })),
      links: row.links?.map((l) => ({
        id: l.id,
        ticketId: l.ticketId,
        url: l.url,
        provider: l.provider,
        externalRef: l.externalRef,
        linkType: l.linkType,
        prNumber: l.prNumber,
        prState: l.prState,
        prUpdatedAt: l.prUpdatedAt,
        createdAt: l.createdAt,
      })),
    };
  }

  async findProjectBySlug(slug: string): Promise<TicketProject | null> {
    return this.db.project.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        key: true,
        gitRemoteUrl: true,
        autoIndexOnClose: true,
        deletedAt: true,
      },
    });
  }

  async findLastTicketInProject(projectId: string): Promise<{ number: number } | null> {
    return this.db.ticket.findFirst({
      where: { projectId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });
  }

  async createTicket(data: CreateTicketData): Promise<TicketDomain> {
    const row = await this.db.ticket.create({ data });
    return this.toDomain(row);
  }

  async findTicketPage(filters: TicketListFilters, page: IPageOption): Promise<IPageResult<TicketDomain>> {
    const where: Prisma.TicketWhereInput = {
      projectId: filters.projectId,
      deletedAt: null,
      ...(filters.status && { status: filters.status }),
      ...(filters.type && { type: filters.type }),
      ...(filters.priority && { priority: filters.priority }),
      ...(filters.unassigned
        ? { assignedToUserId: null, assignedToAgentId: null }
        : {
            ...(filters.assignedToUserId && { assignedToUserId: filters.assignedToUserId }),
            ...(filters.assignedToAgentId && { assignedToAgentId: filters.assignedToAgentId }),
          }),
    };

    // `number` is unique per project, so it is a total order for offset paging.
    const rows = await Paginate(this.db.ticket, page, {
      where,
      orderBy: { number: 'asc' },
      include: { labels: { include: { label: true } }, links: true },
    });
    return rows.remap((row: PrismaTicketRow) => this.toDomain(row));
  }

  async findTicketByProjectAndNumber(
    projectId: string,
    number: number,
  ): Promise<TicketDomain | null> {
    const row = await this.db.ticket.findUnique({
      where: { projectId_number: { projectId, number } },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return row ? this.toDomain(row) : null;
  }

  async findTicketById(id: string): Promise<TicketDomain | null> {
    const row = await this.db.ticket.findUnique({
      where: { id },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return row ? this.toDomain(row) : null;
  }

  async updateTicket(id: string, data: UpdateTicketData): Promise<TicketDomain> {
    const row = await this.db.ticket.update({
      where: { id },
      data,
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return this.toDomain(row);
  }

  async assignTicket(id: string, data: AssignTicketData): Promise<TicketDomain> {
    const row = await this.db.ticket.update({
      where: { id },
      data,
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return this.toDomain(row);
  }

  async softDeleteTicket(id: string): Promise<TicketDomain> {
    const row = await this.db.ticket.update({
      where: { id },
      data: { deletedAt: new Date() },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return this.toDomain(row);
  }

  async findUserById(id: string): Promise<{ id: string; role: string } | null> {
    return this.db.user.findUnique({ where: { id }, select: { id: true, role: true } });
  }

  async findAgentById(id: string): Promise<{ id: string } | null> {
    return this.db.agent.findUnique({ where: { id }, select: { id: true } });
  }

  async findProjectMemberRole(projectId: string, userId: string): Promise<string | null> {
    const member = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async findTicketByRefRaw(projectSlug: string, ref: string): Promise<TicketDomain | null> {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true, key: true },
    });

    if (!project) return null;

    // H5: transitions resolve through the same scoped predicate as reads —
    // cross-project CUIDs, foreign KEY prefixes and soft-deleted tickets all
    // miss (deletedAt: null is applied by findTicketScoped by default).
    return this.findTicketScoped(project.id, project.key, ref);
  }

  async findTicketScoped(
    projectId: string,
    projectKey: string,
    ref: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<TicketDomain | null> {
    const match = parseTicketRef(ref);

    if (match) {
      // H5: a foreign KEY prefix never resolves locally, even when the
      // project happens to own the same ticket number.
      if (match.prefix !== projectKey) return null;

      const row = await this.db.ticket.findUnique({
        where: { projectId_number: { projectId, number: match.number } },
        include: {
          labels: { include: { label: true } },
          links: true,
        },
      });
      return row && (opts.includeDeleted || !row.deletedAt) ? this.toDomain(row) : null;
    }

    // H5: CUID refs are constrained to the caller's project — a valid CUID
    // belonging to another project must not resolve.
    const row = await this.db.ticket.findFirst({
      where: { id: ref, projectId },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return row && (opts.includeDeleted || !row.deletedAt) ? this.toDomain(row) : null;
  }

  // Extra method used by ticket-transitions for full ticket with comments for RAG indexing
  async findTicketWithComments(id: string): Promise<(TicketDomain & { comments: { type: string; body: string }[] }) | null> {
    return this.db.ticket.findUnique({
      where: { id },
      include: { comments: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  }

  // Transition-specific write methods (used inside txManager.run())

  // M3: conditional status write — only updates when the row still holds
  // `from`. Returns the fresh domain row, or null when 0 rows matched
  // (another writer transitioned the ticket between read and write).
  // Final-review hardening: `deletedAt: null` excludes soft-deleted rows, so a
  // ticket deleted between the pre-read and this write can no longer be
  // transitioned (callers' pre-reads already filter deleted tickets).
  async updateTicketStatusIf(id: string, from: string, to: string): Promise<TicketDomain | null> {
    const rows = await this.db.ticket.updateMany({
      where: { id, status: from, deletedAt: null },
      data: { status: to },
    });
    if (rows.count === 0) return null;
    const row = await this.db.ticket.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async createComment(data: {
    ticketId: string;
    body: string;
    type: string;
    authorUserId: string | null;
    authorAgentId: string | null;
  }): Promise<{ id: string; ticketId: string; body: string; type: string; authorUserId: string | null; authorAgentId: string | null; createdAt: Date; updatedAt: Date }> {
    return this.db.comment.create({ data });
  }

  async createTicketActivity(data: {
    ticketId: string;
    action: string;
    fromStatus?: string;
    toStatus?: string;
    actorUserId?: string | null;
    actorAgentId?: string | null;
  }): Promise<{ id: string; ticketId: string; action: string; fromStatus: string | null; toStatus: string | null; actorUserId: string | null; actorAgentId: string | null; createdAt: Date }> {
    return this.db.ticketActivity.create({ data });
  }

  async createTicketLink(data: {
    ticketId: string;
    url: string;
    provider: string;
    externalRef: string;
    linkType: string;
    prNumber?: number | null;
    prState?: string | null;
    prUpdatedAt?: Date | null;
  }): Promise<{ id: string }> {
    return this.db.ticketLink.create({ data });
  }

  async updateTicketLink(id: string, data: {
    url?: string;
    externalRef?: string;
    prNumber?: number;
    prState?: string;
    prUpdatedAt?: Date;
    linkType?: string;
  }): Promise<{ id: string }> {
    return this.db.ticketLink.update({ where: { id }, data });
  }
}
