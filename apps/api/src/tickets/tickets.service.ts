import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { TicketType, TicketStatus, Priority } from '@prisma/client';

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
  sub: string;
  role?: string;
}

@Injectable()
export class TicketsService {
  constructor(private prisma: PrismaService) {}

  async create(
    projectSlug: string,
    createTicketDto: CreateTicketDto,
    currentUser: CurrentUser,
    actorType: 'user' | 'agent',
  ) {
    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Validate required fields
    if (createTicketDto.type === undefined) {
      throw new BadRequestException('Type is required');
    }
    if (createTicketDto.title === undefined) {
      throw new BadRequestException('Title is required');
    }
    if (typeof createTicketDto.title === 'string' && createTicketDto.title.trim().length === 0) {
      throw new BadRequestException('Title must not be empty');
    }
    if (createTicketDto.description !== undefined && typeof createTicketDto.description === 'string' && createTicketDto.description.trim().length === 0) {
      throw new BadRequestException('Description must not be empty if provided');
    }

    // Use transaction to safely auto-increment ticket number
    const ticket = await this.prisma.$transaction(async (tx) => {
      // Find the highest number for this project
      const lastTicket = await tx.ticket.findFirst({
        where: { projectId: project.id, deletedAt: null },
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
          createdByUserId: actorType === 'user' ? currentUser.sub : null,
          createdByAgentId: actorType === 'agent' ? currentUser.sub : null,
        },
      });
    });

    return ticket;
  }

  async findAll(projectSlug: string, filters: FindAllFilters) {
    // Find project by slug
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Build where clause
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
      this.prisma.ticket.findMany({
        where: whereConditions,
        take: limit,
        skip,
        orderBy: { number: 'asc' },
      }),
      this.prisma.ticket.count({ where: whereConditions }),
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
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Check if ref matches KODA-42 format (projectKey-number)
    const refPattern = /^([A-Z]+)-(\d+)$/;
    const match = ref.match(refPattern);

    let ticket;

    if (match) {
      // Resolve by composite unique key (projectId, number)
      const number = parseInt(match[2], 10);
      ticket = await this.prisma.ticket.findUnique({
        where: {
          projectId_number: {
            projectId: project.id,
            number,
          },
        },
      });
    } else {
      // Treat as CUID
      ticket = await this.prisma.ticket.findUnique({
        where: { id: ref },
      });
    }

    // Don't return soft-deleted tickets
    if (ticket && ticket.deletedAt) {
      return null;
    }

    return ticket || null;
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
      throw new NotFoundException('Ticket not found');
    }

    // Build update data - only allow updating mutable fields
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
    return this.prisma.ticket.update({
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
      throw new ForbiddenException('Only admins can delete tickets');
    }

    if (actorType === 'agent') {
      throw new ForbiddenException('Agents cannot delete tickets');
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    // Soft delete by setting deletedAt
    return this.prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async assign(projectSlug: string, ref: string, assignInput: AssignInput) {
    // Validate that we don't have both userId and agentId
    if (assignInput.userId && assignInput.agentId) {
      throw new BadRequestException('Cannot assign to both user and agent');
    }

    // Find project
    const project = await this.prisma.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    // Find ticket by ref
    const ticket = await this.findByRef(projectSlug, ref);
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }

    // Update assignment
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

    return this.prisma.ticket.update({
      where: { id: ticket.id },
      data: updateData,
    });
  }
}
