import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import type {
  ITicketRepository,
  TicketProject,
  TicketDomain,
  FindTicketsFilters,
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

  async findTicketsByProject(filters: FindTicketsFilters): Promise<TicketDomain[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereConditions: Record<string, any> = {
      projectId: filters.projectId,
      deletedAt: null,
    };

    if (filters.status) {
      whereConditions.status = filters.status;
    }
    if (filters.type) {
      whereConditions.type = filters.type;
    }
    if (filters.priority) {
      whereConditions.priority = filters.priority;
    }
    if (filters.unassigned) {
      whereConditions.AND = [
        { assignedToUserId: null },
        { assignedToAgentId: null },
      ];
    } else if (filters.assignedToUserId) {
      whereConditions.assignedToUserId = filters.assignedToUserId;
    }

    const skip = (filters.page - 1) * filters.limit;

    const rows = await this.db.ticket.findMany({
      where: whereConditions,
      take: filters.limit,
      skip,
      orderBy: { number: 'asc' },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async countTicketsByProject(
    filters: Omit<FindTicketsFilters, 'limit' | 'page'>,
  ): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereConditions: Record<string, any> = {
      projectId: filters.projectId,
      deletedAt: null,
    };

    if (filters.status) whereConditions.status = filters.status;
    if (filters.type) whereConditions.type = filters.type;
    if (filters.priority) whereConditions.priority = filters.priority;
    if (filters.unassigned) {
      whereConditions.AND = [
        { assignedToUserId: null },
        { assignedToAgentId: null },
      ];
    } else if (filters.assignedToUserId) {
      whereConditions.assignedToUserId = filters.assignedToUserId;
    }

    return this.db.ticket.count({ where: whereConditions });
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

  async findTicketByRefRaw(projectSlug: string, ref: string): Promise<TicketDomain | null> {
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
      select: { id: true },
    });

    if (!project) return null;

    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    if (match) {
      const number = parseInt(match[2], 10);
      const row = await this.db.ticket.findUnique({
        where: { projectId_number: { projectId: project.id, number } },
      });
      return row ? this.toDomain(row) : null;
    }

    const row = await this.db.ticket.findUnique({
      where: { id: ref },
    });
    return row ? this.toDomain(row) : null;
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

  async updateTicketStatus(id: string, status: string): Promise<TicketDomain> {
    const row = await this.db.ticket.update({
      where: { id },
      data: { status },
    });
    return this.toDomain(row);
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
