import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketResponseDto } from './dto/ticket-response.dto';
import { PrismaClient } from '@prisma/client';
import { TicketType, TicketStatus, Priority } from '../common/enums';
import { validateTransition } from './state-machine/ticket-transitions';
import { buildGitUrl } from '../common/utils/git-url.util';

interface FindAllFilters {
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignedTo?: string;
  unassigned?: boolean;
  limit?: number;
  page?: number;
}

interface AssignInput {
  userId?: string;
  agentId?: string;
}

interface CurrentUser {
  id: string;
  sub: string;
  role?: string;
}

@Injectable()
export class TicketsService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db() { return this.prisma.client; }

  private computeGitRefUrl(
    gitRemoteUrl: string | null | undefined,
    gitRefVersion: string | null | undefined,
    gitRefFile: string | null | undefined,
    gitRefLine: number | null | undefined,
  ): string | null {
    if (!gitRefFile) return null;
    return buildGitUrl(gitRemoteUrl, gitRefVersion ?? 'main', gitRefFile, gitRefLine ?? undefined);
  }


  async create(
    projectSlug: string,
    createTicketDto: CreateTicketDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Validate required fields
    if (createTicketDto.type === undefined) {
      throw new ValidationAppException({}, 'tickets');
    }
    if (createTicketDto.title === undefined) {
      throw new ValidationAppException({}, 'tickets');
    }
    if (typeof createTicketDto.title === 'string' && createTicketDto.title.trim().length === 0) {
      throw new ValidationAppException({}, 'tickets');
    }

    // Use transaction to safely auto-increment ticket number
    const ticket = await this.db.$transaction(async (tx) => {
      // Find the highest number for this project (include soft-deleted to avoid number reuse)
      const lastTicket = await tx.ticket.findFirst({
        where: { projectId: project.id },
        orderBy: { number: 'desc' },
      });

      const nextNumber = (lastTicket?.number ?? 0) + 1;

      // Create the ticket with the next number
      return tx.ticket.create({
        data: {
          projectId: project.id,
          number: nextNumber,
          type: createTicketDto.type,
          title: createTicketDto.title,
          description: createTicketDto.description || null,
          status: TicketStatus.CREATED,
          priority: createTicketDto.priority || Priority.MEDIUM,
          createdByUserId: actorType === 'user' ? currentUser.id : null,
          createdByAgentId: actorType === 'agent' ? currentUser.id : null,
        },
      });
    });

    return TicketResponseDto.from({ ...ticket, ref: `${project.key}-${ticket.number}` }, project.key);
  }

  async findAll(projectSlug: string, filters: FindAllFilters) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereConditions: Record<string, any> = {
      projectId: project.id,
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
    } else if (filters.assignedTo) {
      whereConditions.assignedToUserId = filters.assignedTo;
    }

    // Pagination
    const limit = filters.limit || 20;
    const page = filters.page || 1;
    const skip = (page - 1) * limit;

    // Fetch tickets and total count
    const [tickets, total] = await Promise.all([
      this.db.ticket.findMany({
        where: whereConditions,
        take: limit,
        skip,
        orderBy: { number: 'asc' },
        include: {
          labels: { include: { label: true } },
          links: true,
        },
      }),
      this.db.ticket.count({ where: whereConditions }),
    ]);

    return {
      items: TicketResponseDto.fromMany(tickets, project.key).map((t, i) => {
        // Attach gitRefUrl (computed from project context, not stored on ticket)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = tickets[i] as any;
        return {
          ...t,
          gitRefUrl: this.computeGitRefUrl(
            project.gitRemoteUrl,
            raw.gitRefVersion,
            raw.gitRefFile,
            raw.gitRefLine,
          ),
        };
      }),
      total,
      page,
      limit,
    };
  }

  async findByRef(projectSlug: string, ref: string) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Check if ref matches KODA-42 format (projectKey-number)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ticket: any = null;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.db.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
        include: {
          labels: { include: { label: true } },
          links: true,
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ref },
        include: {
          labels: { include: { label: true } },
          links: true,
        },
      });
    }

    // Don't return soft-deleted tickets
    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Compute ref and gitRefUrl
    const gitRefUrl = this.computeGitRefUrl(
      project.gitRemoteUrl,
      ticket.gitRefVersion,
      ticket.gitRefFile,
      ticket.gitRefLine,
    );
    return TicketResponseDto.from(ticket, project.key, gitRefUrl);
  }

  async update(
    projectSlug: string,
    ref: string,
    updateTicketDto: UpdateTicketDto,
    _currentUser: CurrentUser,
    _actorType: 'user' | 'agent',
  ) {
    // Find ticket by ref (returns TicketResponseDto)
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Build update data - only allow updating mutable fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {};

    if (updateTicketDto.title !== undefined) {
      updateData.title = updateTicketDto.title;
    }
    if (updateTicketDto.description !== undefined) {
      updateData.description = updateTicketDto.description;
    }
    if (updateTicketDto.priority !== undefined) {
      updateData.priority = updateTicketDto.priority;
    }

    if (updateTicketDto.status !== undefined) {
      validateTransition(ticket.status as TicketStatus, updateTicketDto.status);
      updateData.status = updateTicketDto.status;
    }

    // Update the ticket and re-fetch with relations
    const updated = await this.db.ticket.update({
      where: { id: ticket.id },
      data: updateData,
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });

    // Get project for gitRefUrl
    const project = await this.db.project.findUnique({ where: { slug: projectSlug } });
    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    return TicketResponseDto.from(updated, project?.key, gitRefUrl);
  }

  async softDelete(
    projectSlug: string,
    ref: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Check if user has ADMIN role (only applies to users)
    if (actorType === 'user' && currentUser.role && currentUser.role !== 'ADMIN') {
      throw new ForbiddenAppException({}, 'tickets');
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Soft delete by setting deletedAt
    const updated = await this.db.ticket.update({
      where: { id: ticket.id },
      data: {
        deletedAt: new Date(),
      },
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });

    // Get project for gitRefUrl
    const project = await this.db.project.findUnique({ where: { slug: projectSlug } });
    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    return TicketResponseDto.from(updated, project?.key, gitRefUrl);
  }

  async assign(projectSlug: string, ref: string, assignInput: AssignInput) {
    // Validate that we don't have both userId and agentId
    if (assignInput.userId && assignInput.agentId) {
      throw new ValidationAppException({}, 'tickets');
    }

    // Find project
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException({}, 'tickets');
    }

    // Update assignment
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: Record<string, any> = {};

    if (assignInput.userId) {
      updateData.assignedToUserId = assignInput.userId;
      updateData.assignedToAgentId = null;
    } else if (assignInput.agentId) {
      updateData.assignedToAgentId = assignInput.agentId;
      updateData.assignedToUserId = null;
    } else {
      // Unassign
      updateData.assignedToUserId = null;
      updateData.assignedToAgentId = null;
    }

    const updated = await this.db.ticket.update({
      where: { id: ticket.id },
      data: updateData,
      include: {
        labels: { include: { label: true } },
        links: true,
      },
    });

    const gitRefUrl = this.computeGitRefUrl(
      project?.gitRemoteUrl,
      updated.gitRefVersion,
      updated.gitRefFile,
      updated.gitRefLine,
    );
    return TicketResponseDto.from(updated, project?.key, gitRefUrl);
  }
}
