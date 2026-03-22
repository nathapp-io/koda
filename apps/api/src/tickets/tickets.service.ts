import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException, ValidationAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { PrismaClient } from '@prisma/client';
import { TicketType, TicketStatus, Priority } from '../common/enums';

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
      throw new NotFoundAppException();
    }

    // Validate required fields
    if (createTicketDto.type === undefined) {
      throw new ValidationAppException();
    }
    if (createTicketDto.title === undefined) {
      throw new ValidationAppException();
    }
    if (typeof createTicketDto.title === 'string' && createTicketDto.title.trim().length === 0) {
      throw new ValidationAppException();
    }
    if (createTicketDto.description !== undefined && typeof createTicketDto.description === 'string' && createTicketDto.description.trim().length === 0) {
      throw new ValidationAppException();
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

    return { ...ticket, ref: `${project.key}-${ticket.number}` };
  }

  async findAll(projectSlug: string, filters: FindAllFilters) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
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
      }),
      this.db.ticket.count({ where: whereConditions }),
    ]);

    return {
      tickets,
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
      throw new NotFoundAppException();
    }

    // Check if ref matches KODA-42 format (projectKey-number)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    let ticket;

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
        include: { labels: { include: { label: true } } },
      });
    } else {
      // Treat as CUID
      ticket = await this.db.ticket.findUnique({
        where: { id: ref },
        include: { labels: { include: { label: true } } },
      });
    }

    // Don't return soft-deleted tickets
    if (!ticket || ticket.deletedAt) {
      throw new NotFoundAppException();
    }

    // Compute ref (e.g. KT-1) and transform labels from nested structure to flat array
    const ticketRef = `${project.key}-${ticket.number}`;
    if (ticket.labels) {
      interface TicketLabelWithLabel {
        label: { id: string; projectId: string; name: string; color: string | null };
      }
      return {
        ...ticket,
        ref: ticketRef,
        labels: (ticket.labels as TicketLabelWithLabel[]).map((tl: TicketLabelWithLabel) => tl.label),
      };
    }

    return { ...ticket, ref: ticketRef };
  }

  async update(
    projectSlug: string,
    ref: string,
    updateTicketDto: UpdateTicketDto,
    _currentUser: CurrentUser,
    _actorType: 'user' | 'agent',
  ) {
    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException();
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

    // Update the ticket
    return this.db.ticket.update({
      where: { id: ticket.id },
      data: updateData,
    });
  }

  async softDelete(
    projectSlug: string,
    ref: string,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Check if user has ADMIN role (only applies to users)
    if (actorType === 'user' && currentUser.role && currentUser.role !== 'ADMIN') {
      throw new ForbiddenAppException();
    }

    if (actorType === 'agent') {
      throw new ForbiddenAppException();
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException();
    }

    // Soft delete by setting deletedAt
    return this.db.ticket.update({
      where: { id: ticket.id },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async assign(projectSlug: string, ref: string, assignInput: AssignInput) {
    // Validate that we don't have both userId and agentId
    if (assignInput.userId && assignInput.agentId) {
      throw new ValidationAppException();
    }

    // Find project
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundAppException();
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

    return this.db.ticket.update({
      where: { id: ticket.id },
      data: updateData,
    });
  }
}
